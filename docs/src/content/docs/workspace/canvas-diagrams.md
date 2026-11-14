---
title: Diagrams on the canvas (Mermaid and "draw me")
description: Turn Mermaid into shapes you can edit on the canvas, or describe a diagram and let a model on this device draw it.
---

**Diagram…** in the canvas bar opens the diagram dialog. The diagram is
placed in the middle of the view as ordinary canvas shapes: boxes,
arrows and labels you can move, restyle and connect to the rest of the
canvas.

## From Mermaid

Paste a Mermaid definition and choose **Insert** (or press `⌘Enter`).
Five types become editable shapes:

| Type | First line |
|---|---|
| Flowchart | `flowchart TD`, `flowchart LR`, `graph TD` |
| Sequence | `sequenceDiagram` |
| Class | `classDiagram` |
| State | `stateDiagram-v2` |
| Entity–relationship | `erDiagram` |

Other Mermaid types (mindmap, gantt, pie, …) are inserted as a picture of
the diagram, and the dialog says so first.

Before converting, the definition is checked with Mermaid itself, and a
syntax error is shown with Mermaid's message. After converting, every
label of the definition is looked for in the new shapes. If any is
missing, the dialog stays open and names them.

Hebrew labels work in every type. In an ER diagram, entity names must be
Latin: put the Hebrew in the entity's alias, as in
`CUSTOMER["לקוח"] { string name }`.

## "Draw me"

Describe the diagram in a sentence (in Hebrew or English) and choose
**Draw**. A model on this device writes the Mermaid, which then appears in
the dialog for you to check before inserting.

- It runs **only on a local model**: Ollama on this computer, or the model
  in the browser (Settings → AI). It never uses the cloud chat, whatever
  the AI policy says, so nothing leaves the device.
- The answer has to be one of the five editable types and pass Mermaid's
  check. If it doesn't, the model gets the error back and tries again,
  up to twice.
- The labels stay in the language of your request.

The target is a valid diagram for at least 80% of 20 test requests on a
local 7B model. It is measured with
`npm run eval:canvas-draw -- --model qwen2.5:7b`.
