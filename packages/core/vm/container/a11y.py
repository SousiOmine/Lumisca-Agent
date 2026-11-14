#!/usr/bin/env python3
"""The stella machine's accessibility helper.

`vm_find`, `vm_do` and `vm_wait` are thin shims over this program: it walks the
AT-SPI tree of one application and answers one JSON object on stdout. The
platform knowledge lives here rather than in the server because the tree is
only reachable from inside the machine.

WHY A TREE. A screenshot tells the model what the screen looks like; it does
not say which of two identical buttons it is about to press, what a field is
called, or whether the click did anything. The accessibility tree answers
those with names and roles, and an action taken on a named element either
happened to that element or failed — it cannot land on a neighbour because the
layout moved.

REFS. `find` returns refs of the form `@s3f2a1:e12`: a snapshot id and the
element's index in that snapshot. The snapshot (each element's path from the
application root, plus its role and name) is written to disk, because every
tool call is a separate `podman exec` and therefore a separate process — an
in-memory store would be empty by the time `do` runs. `do` re-reads the live
tree, follows the stored path, and refuses the ref if the element's role or
name no longer matches: a ref that no longer identifies what it named is
refused rather than aimed at whatever now occupies that position.

Input: one JSON object on argv[1]. Output: one JSON object on stdout. Anything
that goes wrong is an `error` field holding a sentence a person can read — the
caller shows it to the agent verbatim, so a traceback is not an answer.
"""

import json
import os
import subprocess
import sys
import time

import pyatspi

# A tree walk is bounded so a wedged application cannot hold the run.
WALK_BUDGET_S = 8.0
# How deep the walk descends. Web content nests layout containers several
# levels before the first real widget.
MAX_DEPTH = 40
# Elements one `find` may answer.
DEFAULT_LIMIT = 20
MAX_LIMIT = 60

# Where snapshots are kept. Under /tmp because they are scratch: a machine
# restart drops them, and a ref from before the restart correctly fails.
# One directory per display: a ref names a path in the tree it was read from,
# and two agents' desktops are two trees. DISPLAY is indexed rather than read
# with a default, because without a display there is no tree to read at all.
DISPLAY = os.environ["DISPLAY"]
SNAPSHOT_DIR = os.path.join("/tmp/lumisca-a11y/snapshots", DISPLAY.lstrip(":"))
MAX_SNAPSHOTS = 8

# Roles an agent can act on, whether or not the toolkit advertises an action.
INTERACTIVE_ROLES = {
    "push button",
    "toggle button",
    "check box",
    "radio button",
    "combo box",
    "entry",
    "password text",
    "slider",
    "spin button",
    "menu item",
    "check menu item",
    "radio menu item",
    "page tab",
    "link",
    "tree item",
    "table cell",
    "list item",
    "option",
}

# Container roles that carry no meaning of their own. Reported only when the
# toolkit gave them a name (which an application does for a real region).
LAYOUT_ROLES = {
    "panel",
    "group",
    "filler",
    "section",
    "scroll pane",
    "viewport",
    "tool bar",
    "menu bar",
    "status bar",
    "application",
}

# Roles whose text content is worth reporting separately from the name.
TEXT_ROLES = {
    "label",
    "paragraph",
    "heading",
    "static",
    "table cell",
    "list item",
}

# The action an agent means by "click", most specific first. A toolkit names
# its primary action differently (`press` for a GTK button, `click` for a web
# one, `jump` for a link, `doDefault` for a table cell).
PRIMARY_ACTIONS = (
    "click",
    "press",
    "activate",
    "select",
    "doDefault",
    "jump",
    "open",
)


def state_flags(node):
    """The states worth reporting, as words an agent can act on."""
    try:
        state = node.getState()
    except Exception:
        return []
    flags = []
    for name in (
        "ENABLED",
        "FOCUSED",
        "CHECKED",
        "EXPANDED",
        "SELECTED",
        "EDITABLE",
        "SHOWING",
    ):
        bit = getattr(pyatspi, "STATE_" + name, None)
        if bit is None:
            continue
        try:
            if state.contains(bit):
                flags.append(name.lower())
        except Exception:
            pass
    return flags


def bounds_of(node):
    """Screen rectangle of a node, or None when it cannot be read."""
    try:
        extent = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    except Exception:
        return None
    if extent is None:
        return None
    return {
        "x": extent.x,
        "y": extent.y,
        "width": extent.width,
        "height": extent.height,
    }


def actions_of(node):
    """The action names a node advertises, in the toolkit's order."""
    try:
        action = node.queryAction()
    except Exception:
        return []
    names = []
    for i in range(action.nActions):
        try:
            names.append(action.getName(i))
        except Exception:
            pass
    return names


def text_of(node):
    """The text content of a node: a field's value, or a label's words."""
    try:
        value = node.queryText().getText(0, -1)
        if value:
            return value
    except Exception:
        pass
    if node.getRoleName() in TEXT_ROLES:
        return node.name or ""
    return ""


def children_of(node):
    out = []
    try:
        count = node.childCount
    except Exception:
        return out
    for i in range(count):
        try:
            child = node.getChildAtIndex(i)
        except Exception:
            continue
        if child is not None:
            out.append(child)
    return out


def node_at(app, path):
    """Follow a stored path from the application root."""
    node = app
    for index in path:
        try:
            node = node.getChildAtIndex(index)
        except Exception:
            return None
        if node is None:
            return None
    return node


def walk(app):
    """Every node of an application with the child-index path that reaches it.

    The path is built HERE, as the walk descends, rather than asked of each
    node afterwards: a node's `getIndexInParent` counts from its real parent
    up to the desktop, which is not the frame a walk from the application
    started at (an application's own index on the desktop, and the -1 an
    unparented frame answers, both leak in). A ref built from that chain points
    at a different element the next time it is followed.

    Iterative, because a web page nests deeper than Python's recursion limit,
    and bounded in depth and time. A walk that runs out of budget returns what
    it saw and says so, so a caller never mistakes a cut tree for a complete
    one.
    """
    started = time.time()
    out = []
    stack = [(app, (), 0)]
    complete = True
    while stack:
        if time.time() - started > WALK_BUDGET_S:
            complete = False
            break
        node, path, depth = stack.pop()
        out.append((node, path))
        if depth >= MAX_DEPTH:
            continue
        # Reversed so the children come out in document order.
        stack.extend(
            (child, path + (index,), depth + 1)
            for index, child in reversed(list(enumerate(children_of(node))))
        )
    return out, complete


def application_of(desktop, wanted):
    """The application whose name matches `wanted` (case-insensitive).

    An exact match wins over a substring, so `chromium` finds "Chromium" and a
    name that happens to be a prefix of another does not shadow it. Several
    substring matches are an error that names them: picking one would be a
    guess about which window the agent meant.
    """
    named = []
    for index in range(desktop.childCount):
        try:
            app = desktop.getChildAtIndex(index)
        except Exception:
            continue
        if app is None:
            continue
        name = app.name or ""
        if name:
            named.append((name, app))
    lowered = wanted.lower()
    exact = [app for name, app in named if name.lower() == lowered]
    if exact:
        return exact[0], [name for name, _ in named]
    partial = [(name, app) for name, app in named if lowered in name.lower()]
    if len(partial) == 1:
        return partial[0][1], [name for name, _ in named]
    if len(partial) > 1:
        raise LookupError(
            f"more than one application matches {wanted!r}: "
            + ", ".join(repr(name) for name, _ in partial)
            + ". Name one of them exactly."
        )
    return None, [name for name, _ in named]


def describe(node):
    role = node.getRoleName()
    return {
        "role": role,
        "name": node.name or "",
        "text": text_of(node),
        "states": state_flags(node),
        "actions": actions_of(node),
        "bounds": bounds_of(node),
    }


def matches(record, role, name, text):
    if role is not None and record["role"] != role:
        return False
    if name is not None and name.lower() not in record["name"].lower():
        return False
    if text is not None:
        haystack = (record["name"] + "\n" + record["text"]).lower()
        if text.lower() not in haystack:
            return False
    return True


def is_actionable(record):
    """Whether a record is something an agent can act on or point at."""
    if record["role"] in INTERACTIVE_ROLES:
        return True
    # `showContextMenu` is advertised on nearly every node of a web page and
    # says nothing about whether the node is a control.
    return any(name != "showContextMenu" for name in record["actions"])


# --- snapshots -------------------------------------------------------------


def snapshot_id():
    """An id unique enough for one machine's short-lived snapshots."""
    return f"s{int(time.time() * 1000) % 100000:05d}{os.getpid() % 100:02d}"


def save_snapshot(app_name, nodes):
    """Write one walk to disk and return its id.

    Every tool call is its own process, so the tree a `find` returned cannot
    be kept in memory for the `do` that follows. The store is bounded: the
    oldest files are removed as new ones arrive, so a long conversation cannot
    fill the machine's disk with trees.
    """
    identifier = snapshot_id()
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    payload = {
        "id": identifier,
        "app": app_name,
        "elements": [
            {
                "path": list(path),
                "role": node.getRoleName(),
                "name": node.name or "",
            }
            for node, path in nodes
        ],
    }
    target = os.path.join(SNAPSHOT_DIR, identifier + ".json")
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(tmp, target)
    prune_snapshots()
    return identifier


def prune_snapshots():
    """Keep the newest MAX_SNAPSHOTS files."""
    try:
        names = [n for n in os.listdir(SNAPSHOT_DIR) if n.endswith(".json")]
    except OSError:
        return
    if len(names) <= MAX_SNAPSHOTS:
        return
    paths = [os.path.join(SNAPSHOT_DIR, name) for name in names]
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for stale in paths[MAX_SNAPSHOTS:]:
        try:
            os.remove(stale)
        except OSError:
            pass


def load_snapshot(identifier):
    path = os.path.join(SNAPSHOT_DIR, identifier + ".json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


# --- refs ------------------------------------------------------------------


def parse_ref(ref):
    """Split `@<snapshot>:e<index>` into its parts."""
    if not ref.startswith("@") or ":e" not in ref:
        raise ValueError(
            f"not a ref: {ref!r}. Use a value that find returned "
            "(they look like @s12345:e3)."
        )
    identifier, _, index = ref[1:].partition(":e")
    try:
        return identifier, int(index)
    except ValueError:
        raise ValueError(f"not a ref: {ref!r}") from None


def resolve(request):
    """The live node a ref names, re-identified against the current tree."""
    identifier, index = parse_ref(require(request, "ref"))
    snapshot = load_snapshot(identifier)
    if snapshot is None:
        raise LookupError(
            f"the snapshot {identifier} is gone (the machine restarted, or it "
            "was replaced). Run find again and use the new ref."
        )
    elements = snapshot["elements"]
    if index < 0 or index >= len(elements):
        raise ValueError(f"no element e{index} in snapshot {identifier}")
    element = elements[index]

    app, known = application_of(
        pyatspi.Registry.getDesktop(0), snapshot["app"]
    )
    if app is None:
        raise LookupError(
            f"the application {snapshot['app']!r} is no longer running"
            + (f" (running: {', '.join(known)})" if known else "")
        )
    node = node_at(app, element["path"])
    if node is None:
        raise LookupError(
            f"the element {request['ref']} is gone: the window changed. "
            "Run find again."
        )
    if node.getRoleName() != element["role"] or (node.name or "") != element["name"]:
        raise LookupError(
            f"the element {request['ref']} no longer matches what was found "
            f"({element['role']} {element['name']!r} is now "
            f"{node.getRoleName()} {node.name or ''!r}). Run find again."
        )
    return app, node, tuple(element["path"])


# --- commands --------------------------------------------------------------


def cmd_find(request):
    """Locate elements by role, name or text, and mint refs for them."""
    app, known = application_of(
        pyatspi.Registry.getDesktop(0), require(request, "app")
    )
    if app is None:
        return {
            "error": f"no running application matches {request['app']!r}"
            + (f" (running: {', '.join(known)})" if known else ""),
            "running": known,
        }
    nodes, complete = walk(app)
    identifier = save_snapshot(request["app"], nodes)

    role = request.get("role")
    name = request.get("name")
    text = request.get("text")
    limit = min(max(int(request.get("limit", DEFAULT_LIMIT)), 1), MAX_LIMIT)
    # `actionable` (default yes) filters to what an agent can act on;
    # `actionable: "no"` removes that filter so text and containers can be read
    # too. Layout scaffolding is always skipped — it is not something an agent
    # can use, and naming every wrapper buries the controls it can — unless the
    # caller asked for that role by name.
    only_actionable = bool(request.get("actionable", True))

    found = []
    for index, (node, _path) in enumerate(nodes):
        record = describe(node)
        if record["role"] == "application":
            continue
        if only_actionable and not is_actionable(record):
            continue
        if not matches(record, role, name, text):
            continue
        if record["name"] == "" and record["text"].strip() == "":
            # Nothing to tell the agent about, and nothing it could ask for by
            # name later. Its children are still in the walk.
            continue
        if record["role"] in LAYOUT_ROLES and role != record["role"]:
            continue
        record["ref"] = f"@{identifier}:e{index}"
        found.append(record)
        if len(found) >= limit:
            break

    answer = {
        "snapshot": identifier,
        "app": request["app"],
        "complete": complete,
        "count": len(found),
        "matches": found,
    }
    # A control of zero size is one the toolkit keeps but does not draw (a
    # hidden toolbar button, a collapsed panel): reporting it first is how an
    # agent acts on something nobody can see. They are kept (a caller asking
    # for them by role must still find them) but listed last.
    found.sort(key=lambda record: (
        record["bounds"] is None
        or record["bounds"]["width"] == 0
        or record["bounds"]["height"] == 0
    ))
    if not found:
        # Telling a mistyped role from an empty window is the difference
        # between "look again" and "that control is not there".
        answer["roles_present"] = sorted({
            node.getRoleName() for node, _path in nodes
            if node.getRoleName() != "application"
        })
    return answer


def cmd_get(request):
    """Read one property of a ref."""
    _app, node, _path = resolve(request)
    prop = request.get("property", "text")
    if prop == "text":
        value = text_of(node)
    elif prop == "bounds":
        value = bounds_of(node)
    elif prop == "states":
        value = state_flags(node)
    elif prop == "actions":
        value = actions_of(node)
    elif prop == "value":
        value = text_of(node)
    elif prop == "role":
        value = node.getRoleName()
    elif prop == "name":
        value = node.name or ""
    else:
        raise ValueError(
            "property must be one of text, value, name, role, bounds, "
            "states, actions"
        )
    return {"ref": request["ref"], "property": prop, "value": value}


def cmd_do(request):
    """Act on a ref, then report what could be read back."""
    app, node, _path = resolve(request)
    action = require(request, "action")
    before = state_flags(node)
    role = node.getRoleName()

    if action == "click":
        outcome = activate(node, app)
    elif action == "focus":
        outcome = focus(node)
    elif action == "set_value":
        outcome = set_value(node, require(request, "value"))
    elif action == "key":
        outcome = run_xdotool(["key", "--clearmodifiers", "--", require(request, "key")])
    elif action in ("check", "uncheck"):
        wanted = action == "check"
        if ("checked" in before) == wanted:
            return {
                "ok": True,
                "action": action,
                "unchanged": True,
                "states": before,
            }
        outcome = invoke(node, (action, "click", "press"))
    elif action == "select":
        outcome = select_option(node, app, require(request, "value"))
    elif action == "scroll":
        outcome = scroll(node, request)
    else:
        raise ValueError(
            f"unknown action {action!r}. Use click, focus, set_value, key, "
            "check, uncheck, select or scroll."
        )
    if isinstance(outcome, dict) and "error" in outcome:
        return outcome

    # Read the result back from the live tree. A failed read is reported as
    # `delivered_unverified`, never as success: the app was told to do
    # something and the toolkit accepted it, which is not the same as a
    # visible effect.
    after = read_back(app, role, node.name or "")
    return {
        "ok": True,
        "action": action,
        "role": role,
        "before": before,
        "delivery": "delivered_verified" if after else "delivered_unverified",
        "after": after,
        "outcome": outcome,
    }


def cmd_wait(request):
    """Wait for a tree condition, or for a plain delay."""
    if request.get("ms") is not None:
        milliseconds = min(max(int(request["ms"]), 0), 30_000)
        time.sleep(milliseconds / 1000.0)
        return {"ok": True, "waited_ms": milliseconds}

    app_name = require(request, "app")
    timeout_ms = min(max(int(request.get("timeout_ms", 5000)), 100), 30_000)
    started = time.time()
    deadline = started + timeout_ms / 1000.0
    role = request.get("role")
    name = request.get("name")
    text = request.get("text")
    gone = bool(request.get("gone", False))
    last_count = None

    while True:
        app, _known = application_of(pyatspi.Registry.getDesktop(0), app_name)
        present = False
        if app is not None:
            nodes, _complete = walk(app)
            last_count = len(nodes)
            present = any(
                matches(describe(node), role, name, text)
                for node, _path in nodes
            )
        if present != gone:
            return {
                "ok": True,
                "present": present,
                "waited_ms": int((time.time() - started) * 1000),
            }
        if time.time() >= deadline:
            return {
                "error": f"the condition did not hold within {timeout_ms} ms"
                + (f" (last walk saw {last_count} elements)"
                   if last_count is not None else "")
            }
        time.sleep(0.2)


# --- actions ---------------------------------------------------------------


def invoke(node, preferred):
    """Run the first of `preferred` that the node advertises."""
    try:
        action = node.queryAction()
    except Exception:
        return {"error": f"the {node.getRoleName()} exposes no actions"}
    available = []
    for index in range(action.nActions):
        try:
            available.append((action.getName(index), index))
        except Exception:
            pass
    for wanted in preferred:
        for name, index in available:
            if name != wanted:
                continue
            try:
                ok = action.doAction(index)
            except Exception as error:
                return {"error": f"{name} failed: {error}"}
            if not ok:
                return {"error": f"{name} reported failure"}
            return {"done": name}
    offered = ", ".join(name for name, _ in available) or "none"
    return {
        "error": f"the {node.getRoleName()} has none of "
        f"{', '.join(preferred)} (it offers: {offered})"
    }


def activate(node, app):
    """Do what a click would: the primary action, or the pointer as a last
    resort when the toolkit exposes no action at all."""
    names = actions_of(node)
    for preferred in PRIMARY_ACTIONS:
        if preferred in names:
            return invoke(node, (preferred,))
    box = bounds_of(node)
    if box is None:
        return {"error": f"the {node.getRoleName()} has no action and no extent"}
    click_point(
        box["x"] + box["width"] // 2,
        box["y"] + box["height"] // 2,
    )
    return {"done": "pointer"}


def focus(node):
    try:
        node.queryComponent().grabFocus()
    except Exception as error:
        return {"error": f"the {node.getRoleName()} cannot take the focus: {error}"}
    return {"done": "focus"}


def _select_all(node):
    """Select a field's contents so typing replaces them."""
    try:
        text = node.queryText()
        count = text.characterCount
        if count:
            text.setSelection(0, 0, count)
            return True
    except Exception:
        pass
    return False


def set_value(node, value):
    """Write text into a field.

    Two routes, because a toolkit offers only one of them: GTK's fields have
    `EditableText`, whose `setTextContents` writes the value directly, while a
    web field exposes only `Text` and takes keyboard input. The keyboard route
    focuses the field and selects what is there first, so the characters land
    in the field and replace its contents rather than appending to whatever
    had the focus.
    """
    try:
        editable = node.queryEditableText()
        if editable.isEditable(0):
            editable.setTextContents(value)
            return {"done": "EditableText"}
    except NotImplementedError:
        pass
    except Exception:
        pass

    try:
        component = node.queryComponent()
        component.grabFocus()
    except Exception:
        return {
            "error": "the field cannot take the focus, so no text can be "
            "typed into it"
        }
    # Wait for the focus to actually land: typing into a field the toolkit has
    # not focused yet loses the first characters, which reads as a corrupted
    # value rather than as a race.
    for _ in range(20):
        if "focused" in state_flags(node):
            break
        time.sleep(0.02)
    # Select everything so the typing REPLACES the value instead of appending
    # to it (a click in a field leaves the caret anywhere).
    _select_all(node)
    time.sleep(0.05)
    result = run_xdotool(
        ["type", "--clearmodifiers", "--delay", "20", "--", value]
    )
    if "error" in result:
        return result
    # Typing into a field that had a selection can drop a character when the
    # key lands before the selection is applied; send Select-all once more and
    # verify, retrying the whole write when the value did not arrive intact.
    for _ in range(2):
        time.sleep(0.15)
        if text_of(node) == value:
            return result
        _select_all(node)
        time.sleep(0.05)
        result = run_xdotool(
            ["type", "--clearmodifiers", "--delay", "30", "--", value]
        )
        if "error" in result:
            return result
    return result


def select_option(node, app, value):
    """Choose an option in a combo box or list, by its visible name."""
    names = actions_of(node)
    if "open" in names:
        if "expanded" in state_flags(node):
            # A popup left open by an earlier call: `open` on an open combo
            # does nothing, so the item would never be found.
            invoke(node, ("click", "press"))
            time.sleep(0.3)
        opened = invoke(node, ("open",))
        if "error" in opened:
            return opened
        # The popup is a separate window; give the toolkit a moment to
        # publish it before walking for the item.
        time.sleep(0.4)
        picked = pick_option(app, value)
        if "error" in picked:
            return picked
        # The popup closes after the choice, and the node held here still
        # carries the `expanded` it had while the popup was open. Wait until a
        # FRESH walk sees it collapsed, so the state the caller reads back
        # describes the combo rather than the popup.
        #
        # Choosing the item that was already selected changes nothing, and
        # some toolkits leave the popup open for it. Escape closes it, so the
        # screen is not left with a menu covering it after a successful call.
        for _ in range(25):
            latest = read_back(app, node.getRoleName(), node.name or "")
            if "expanded" not in latest.get("states", []):
                return picked
            time.sleep(0.06)
        run_xdotool(["key", "--clearmodifiers", "--", "Escape"])
        return picked
    for child in children_of(node):
        if (child.name or "") == value:
            return invoke(child, PRIMARY_ACTIONS)
    return {
        "error": f"no option named {value!r} in the {node.getRoleName()}"
    }


def pick_option(app, value):
    """Activate an item of the popup that just opened."""
    nodes, _complete = walk(app)
    options = []
    for node, _path in nodes:
        if node.getRoleName() not in ("menu item", "list item", "table cell"):
            continue
        if (node.name or "") == value:
            return invoke(node, PRIMARY_ACTIONS)
        if node.name:
            options.append(node.name)
    return {
        "error": f"no option named {value!r}"
        + (f" (offered: {', '.join(sorted(set(options)))})" if options else "")
    }


def scroll(node, request):
    """Scroll by wheel events over the target's centre."""
    vertical = int(request.get("vertical", 0))
    horizontal = int(request.get("horizontal", 0))
    if vertical == 0 and horizontal == 0:
        return {"error": "scroll needs a vertical or horizontal amount"}
    box = bounds_of(node)
    if box is None:
        return {"error": "the target has no extent to scroll over"}
    return wheel(
        box["x"] + box["width"] // 2,
        box["y"] + box["height"] // 2,
        vertical,
        horizontal,
    )


def wheel(x, y, vertical, horizontal):
    """Wheel input at a point.

    X11's wheel buttons are 4 up, 5 down, 6 left, 7 right, and they name the
    direction the WHEEL rolls rather than the direction the content moves:
    button 5 rolls down and the page scrolls down. One click is one notch, so
    the amount is divided by the notch size the tool documents (100) and
    capped at 20 notches — a request cannot spin a list for minutes.
    """
    buttons = []
    if vertical:
        buttons.append("5" if vertical > 0 else "4")
    if horizontal:
        buttons.append("7" if horizontal > 0 else "6")
    notches = max(1, min(20, (max(abs(vertical), abs(horizontal)) + 99) // 100))
    for button in buttons:
        result = run_xdotool(
            ["mousemove", str(x), str(y), "click", "--repeat", str(notches), button]
        )
        if "error" in result:
            return result
    return {"done": "wheel", "notches": notches}


def click_point(x, y):
    result = run_xdotool(["mousemove", str(x), str(y), "click", "1"])
    if "error" in result:
        return result
    return {"done": "pointer"}


def run_xdotool(argv):
    """Run xdotool, turning its failure into a sentence."""
    try:
        result = subprocess.run(
            ["xdotool", *argv], capture_output=True, text=True, timeout=20
        )
    except FileNotFoundError:
        return {"error": "xdotool is missing from the machine's image"}
    except subprocess.TimeoutExpired:
        return {"error": "the input call timed out"}
    if result.returncode != 0:
        return {"error": result.stderr.strip() or "the input call failed"}
    return {"done": "xdotool"}


def read_back(app, role, name):
    """What the acted-on element says about itself now, or {} when it cannot
    be found again.

    The element is looked up by IDENTITY in a fresh walk — same role, same
    name — rather than at the path it had. An action changes the tree (a menu
    closes and its row shows something else, a table re-sorts, a banner
    appears), so the index chain that reached the element before the action
    reaches a different element afterwards; reading that one would report a
    neighbour's state as the target's. Nothing found means nothing is known,
    which the caller reports as `delivered_unverified` instead of guessing.
    """
    if name == "":
        # An unnamed element cannot be re-identified after the tree moved.
        return {}
    nodes, _complete = walk(app)
    for node, _path in nodes:
        if node.getRoleName() != role or (node.name or "") != name:
            continue
        states = state_flags(node)
        return {
            "name": node.name or "",
            "text": text_of(node),
            "states": states,
            "checked": "checked" in states,
        }
    return {}


# --- entry point -----------------------------------------------------------


def require(request, key):
    value = request.get(key)
    if value is None or value == "":
        raise ValueError(f"{key} is required")
    return value


COMMANDS = {
    "find": cmd_find,
    "get": cmd_get,
    "do": cmd_do,
    "wait": cmd_wait,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: a11y.py '<json request>'"}))
        return 1
    try:
        request = json.loads(sys.argv[1])
    except json.JSONDecodeError as error:
        print(json.dumps({"error": f"the request is not JSON: {error}"}))
        return 1
    command = request.get("command")
    handler = COMMANDS.get(command)
    if handler is None:
        print(json.dumps({
            "error": f"unknown command {command!r}",
            "commands": sorted(COMMANDS),
        }))
        return 1
    try:
        answer = handler(request)
    except (LookupError, ValueError) as error:
        answer = {"error": str(error)}
    except Exception as error:
        # A traceback is not something an agent can act on; the message is.
        answer = {"error": f"{type(error).__name__}: {error}"}
    print(json.dumps(answer, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
