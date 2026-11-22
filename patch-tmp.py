import pathlib
p = pathlib.Path("/home/agent/agents/Lumisca-Agent/packages/web/src/shell.ts")
s = p.read_text()
s = s.replace("  error: string | null;", "  error: { code: string; detail: string } | string | null;")
p.write_text(s)

p = pathlib.Path("/home/agent/agents/Lumisca-Agent/packages/web/src/components/settings/UpdateSection.tsx")
s = p.read_text()
s = s.replace("  error: { code: string; detail: string },", "  error: { code: string; detail: string } | string,")
s = s.replace('''  switch (error.code) {''', '''  if (typeof error === "string") return error;
  switch (error.code) {''')
p.write_text(s)
print("done")
