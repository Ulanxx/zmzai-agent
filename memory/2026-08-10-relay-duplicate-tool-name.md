# Relay duplicate tool name

- Symptom: a task displayed `Tool listlist not found` even though the registered tool is `list`.
- Root cause: OpenAI-compatible Relay streams can repeat a complete `function.name` in multiple tool-call chunks. `lib/relay-agent-stream.ts` appended every name chunk, converting `list` plus `list` into `listlist`.
- Fix: `mergeToolCallName` accepts repeated complete names, a later complete name, and genuine name fragments.
- Regression test: `lib/relay-agent-stream.test.ts` covers duplicate `list`, `li` + `st`, and `li` + `list`.
