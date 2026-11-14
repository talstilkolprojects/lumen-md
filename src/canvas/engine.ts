/**
 * Which canvas engine the app runs (plan 4.19).
 *
 * `true` since part 2: the canvas is `CanvasExcalidraw.tsx`, which opens
 * `.excalidraw` files, so the "convert tldraw canvases to Excalidraw"
 * palette command is offered. (It was `false` while the canvas was still
 * tldraw and nothing could open the converted files.)
 */
export const EXCALIDRAW_CANVAS_ENABLED: boolean = true;
