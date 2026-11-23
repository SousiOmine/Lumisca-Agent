/**
 * The five calls a session and a conversation share are written once
 * (api-conversation.ts). This pins that one family cannot drift from the
 * other: the same call on either family must produce the same method, the same
 * body shape and the same answer, differing only in its path — which is the
 * whole reason the two copies were merged.
 *
 * The regression this guards: api-local.ts and api-stella.ts each spelled
 * `prompt`'s body, `answer`'s body and the four other calls themselves, so a
 * fix to one (the prompt body gaining images, the answer's shape) could land in
 * one file and not the other, and only one surface would break.
 */
import { test } from "bun:test";
import { enc, paths, routePath } from "@lumisca/core/shared";
import { assertEquals } from "@std/assert";
import {
  type ConversationFamily,
  conversationCalls,
  sessionFamily,
  stellaFamily,
} from "./api-conversation.ts";

/** One call the two families share, as a name, its args and the method the
 * request must use. */
interface Case {
  name: "getRevision" | "prompt" | "abort" | "rewind" | "answer";
  method: string;
  args: unknown[];
  body?: unknown;
}

/** The args below are the call's own (the peer id and the id are supplied by
 * the test, not the case). */
const CASES: Case[] = [
  { name: "getRevision", method: "GET", args: [] },
  { name: "prompt", method: "POST", args: ["hello"], body: { text: "hello" } },
  { name: "abort", method: "POST", args: [] },
  {
    name: "rewind",
    method: "POST",
    args: [1700000000000],
    body: { timestamp: 1700000000000 },
  },
  {
    name: "answer",
    method: "POST",
    args: ["call-1", [{ id: "q1", values: ["yes"] }]],
    body: { toolCallId: "call-1", answers: [{ id: "q1", values: ["yes"] }] },
  },
];

/** One request a call made, as these tests care about it. */
interface Sent {
  peerId: string;
  method: string;
  path: string;
  body: string | undefined;
}

/** Run one case against one family on one machine, recording the request. */
async function sentFor(
  family: ConversationFamily<never>,
  testCase: Case,
  peerId = "",
): Promise<Sent> {
  const sent: Sent[] = [];
  const calls = conversationCalls(family, (machineId, path, init) => {
    sent.push({
      peerId: machineId,
      method: init?.method ?? "GET",
      path,
      body: init?.body as string | undefined,
    });
    return Promise.resolve({} as never);
  });
  const call = calls[testCase.name] as (
    peerId: string,
    id: string,
    ...args: unknown[]
  ) => Promise<unknown>;
  await call(peerId, "c 1", ...testCase.args);
  assertEquals(sent.length, 1, `${testCase.name}: exactly one request`);
  return sent[0]!;
}

test("both families send every shared call the same way", async () => {
  // The two families differ in their path and their prompt's tail; the method
  // and the body's shape are the shared module's, so neither can carry a
  // second spelling of them.
  for (const testCase of CASES) {
    for (const family of [sessionFamily, stellaFamily]) {
      const sent = await sentFor(family, testCase);
      assertEquals(sent.method, testCase.method, `${family.idParam}: method`);
      assertEquals(
        sent.body,
        testCase.body === undefined ? undefined : JSON.stringify(testCase.body),
        `${family.idParam}: body of ${testCase.name}`,
      );
    }
  }
});

test("a family's path is the template the server registers, with its own id", async () => {
  // The server registers `routePath(template)` (Hono's `:id` form) and the
  // client fills the same template with an escaped id. Comparing the request's
  // concrete path with the server's form — its parameter swapped for the same
  // escaped id — is what makes a path renamed on one side a failure here
  // instead of two paths that each look right on their own.
  const id = "c 1";
  const serverForm = (template: string) =>
    routePath(template).replace(/:[A-Za-z]\w*/, enc(id));
  /** The keys a path is read from (`idParam` is a name, `body` a function —
   * neither is a path). */
  type PathKey = Exclude<keyof ConversationFamily<never>, "idParam" | "body">;
  const cases: Array<[name: Case["name"], key: PathKey]> = [
    ["getRevision", "revision"],
    ["prompt", "prompt"],
    ["abort", "abort"],
    ["rewind", "rewind"],
    ["answer", "answer"],
  ];
  for (const family of [sessionFamily, stellaFamily]) {
    for (const [name, key] of cases) {
      const sent = await sentFor(family, CASES.find((c) => c.name === name)!);
      assertEquals(
        sent.path,
        serverForm(family[key]),
        `${family.idParam}: ${name}`,
      );
    }
  }
  // And the families name the API's own templates, not a table of their own.
  assertEquals(sessionFamily.prompt, paths.sessionPrompt);
  assertEquals(stellaFamily.prompt, paths.conversationPrompt);
});

test("a prompt carries the tail its family takes, and nothing else", async () => {
  const images = [
    { data: "data:image/png;base64,QUJD", mimeType: "image/png" },
  ];
  // Code mode's tail is the composer's mode badge; a session's prompt route
  // refuses uploaded files, so its body has no `uploads`.
  const session = await sentFor(sessionFamily, {
    name: "prompt",
    method: "POST",
    args: [
      "look",
      images,
      { modeId: "review", optionId: "quick", modeLabel: "R", shortText: "R" },
    ],
  });
  assertEquals(JSON.parse(session.body!), {
    text: "look",
    images: [{ data: "QUJD", mimeType: "image/png" }],
    mode: {
      modeId: "review",
      optionId: "quick",
      modeLabel: "R",
      shortText: "R",
    },
  });

  // A conversation's is the files it moved into its machine first.
  const stella = await sentFor(stellaFamily, {
    name: "prompt",
    method: "POST",
    args: [
      "look",
      images,
      [
        {
          id: "f1",
          name: "run.log",
          size: 5,
          file: new File(["hello"], "run.log"),
          status: "done",
          uploaded: 5,
          uploadId: "u1",
        },
      ],
    ],
  });
  assertEquals(JSON.parse(stella.body!), {
    text: "look",
    images: [{ data: "QUJD", mimeType: "image/png" }],
    uploads: ["u1"],
  });
});

test("the peer id names the machine and never enters the path", async () => {
  // A session's table is reached as this server ("") and through the fed proxy
  // (a peer id): the same call, addressed at a different machine — so the peer
  // id must be the transport's alone.
  const sent = await sentFor(sessionFamily, CASES[0]!, "peer 1");
  assertEquals(sent.peerId, "peer 1");
  assertEquals(sent.path, "/sessions/c%201/revision");
});

test("a family's id is escaped into the hole its family names", async () => {
  const session = await sentFor(sessionFamily, CASES[1]!);
  assertEquals(session.path, "/sessions/c%201/prompt");
  const stella = await sentFor(stellaFamily, CASES[1]!);
  assertEquals(stella.path, "/stella/conversations/c%201/prompt");
  // And those are the server's own registrations, not a parallel spelling.
  assertEquals(routePath(paths.sessionPrompt), "/sessions/:id/prompt");
  assertEquals(
    routePath(paths.conversationPrompt),
    "/stella/conversations/:agentId/prompt",
  );
});
