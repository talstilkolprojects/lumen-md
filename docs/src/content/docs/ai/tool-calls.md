---
title: Reliable tool calls on small local models
description: How Lumen keeps a 7–12B local model's tool calls valid. Every call is held to a JSON schema, common slips are repaired, and an invalid call gets one retry before Lumen asks you.
---

Agents use tools to do their work: they search your notes, read a file,
or propose a change. A cloud model rarely gets a tool call wrong. A small
model on your own computer, like `qwen2.5:7b` or `gemma3:12b`, often does.
Lumen does four things about it.

## 1. Every call is held to a schema

On Ollama 0.5 or later, Lumen sends a JSON schema with every turn of a
local model (Ollama's *structured outputs*). The model can only answer with
a call to one of the agent's tools, with that tool's arguments, or with
the final answer. Cloud models above the small tier still use their own
native tool calls.

## 2. Common slips are repaired

Even with a schema, small models make the same slips again and again.
Lumen fixes these before it checks the call:

- the call in a different format (`{"name", "arguments"}`, `{"function": …}`,
  `{"action", "action_input"}`)
- the arguments sent as a JSON string, or wrapped in an extra object
- the tool name in another case (`SearchNotes` for `search_notes`)
- a key in another case (`Query` for `query`)
- a number or yes/no sent as text, or one value where a list is expected
- an extra property the tool doesn't take
- trailing commas, curly quotes, and Python's `True` / `None`

Lumen never invents a value you didn't give. If something required is
missing, the call stays invalid.

## 3. One retry, then a question for you

After an invalid call, the model sees what was wrong and the tool's exact
schema, and gets one more try. If that call is invalid too, the agent stops
and asks you to say what's needed. It doesn't guess.

## 4. Nothing is written without your approval

A repaired call goes through the same checks as any other call:
permissions, the network gate, and the approval screen for changes. A
repair can't make a call do more than it was allowed to do.

## How it's measured

There are 200 requests, 100 in Hebrew and 100 in English, over ten of the
agents' tools. Each request offers five tools, and only one is right.

```sh
npm run eval:tool-calls -- --models qwen2.5:7b,gemma3:12b
```

The target is at least 95% valid calls on both models. A valid call means
the right tool with arguments that match its schema. The report also shows
how many calls the old parser would have accepted, how many were repaired
or retried, and how many ended with a question to you. The same run is one
step of `npm run models:day`.
