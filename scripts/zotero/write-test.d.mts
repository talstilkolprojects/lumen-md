import type { PdfAnnotation } from "../../src/pdf/annotations";
import type { ZoteroAnnotationItem, ZoteroCall } from "../../src/citations/zoteroAnnotations";
export function sampleAnnotations(run: string): PdfAnnotation[];
export function compareBack(sentItems: ZoteroAnnotationItem[], readBack: Array<Record<string, unknown>>): string[];
export function fakeLibrary(user: number, parent: string): { call: ZoteroCall; items: Map<string, Record<string, unknown>> };
