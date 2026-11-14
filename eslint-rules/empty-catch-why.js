/**
 * Plan 0.4.2 / 12.1: an error that is swallowed must say why, with a comment
 * that starts with `why:` inside the empty handler:
 *
 *   try { localStorage.setItem(k, v); } catch { /* why: storage denied in private mode *\/ }
 *   void save().catch(() => { /* why: best effort, the next save retries *\/ });
 *
 * Covered: an empty `catch` block, and an empty function passed to a
 * promise's `.catch(…)`. A handler that does something (even just
 * `return null`, or `.catch(() => null)` as a fallback value) is not affected.
 */
const WHY = /^\s*why:\s*\S/;

/** Leading whitespace and block-comment stars ("/**", "/*\n * why: …") are not text. */
function hasWhy(source, node) {
  return source.getCommentsInside(node).some((c) => WHY.test(c.value.replace(/^[\s*]+/, "")));
}

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Require a `why:` comment in empty catch blocks and empty `.catch()` handlers" },
    schema: [],
    messages: {
      missing: "Empty catch block: say why the error is ignored with a `// why: …` comment inside it.",
      missingHandler: "Empty `.catch()` handler: say why the rejection is ignored with a `/* why: … */` comment inside it.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CatchClause(node) {
        const block = node.body;
        if (block.body.length > 0) return;
        if (hasWhy(source, block)) return;
        context.report({ node: block, messageId: "missing" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier" || callee.property.name !== "catch") return;
        const handler = node.arguments[0];
        if (!handler || (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression")) return;
        const body = handler.body;
        if (body.type !== "BlockStatement" || body.body.length > 0) return;
        if (hasWhy(source, body)) return;
        context.report({ node: handler, messageId: "missingHandler" });
      },
    };
  },
};
