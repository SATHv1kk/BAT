// AST-based safety screen for model-authored extractor source — a second,
// stronger check layered in front of/behind the text-based denylist in
// extractor-screen.js.
//
// Why a second screen: the regex denylist can only refuse spellings it was
// told about. It has no notion of "this variable IS window" — so
// `var w = window; w.fetch(...)` or `var w = window; w['fetch'](...)` reads
// as ordinary identifier/bracket use unless the specific pattern was already
// anticipated. This module parses the source into a real AST and tracks, by
// actual assignment, which local names become aliases of a dangerous global
// (`window`, `self`, `globalThis`, `top`, `parent`, `frames`, `this`) or of a
// specific dangerous capability pulled off one (`fetch`, `eval`, a Reflect/
// descriptor retrieval of one). A rename or an extra level of indirection
// does not change what a name resolves to, so this closes the aliasing class
// of bypass the text-based screen structurally cannot.
//
// It is still not a sandbox, and still cannot see through fully DYNAMIC
// discovery — `Object.values(w).find(v => v.name === "fetch")` never writes
// the name "fetch" next to any reference to `w` at all, so no static check
// over identifiers can catch it. That residual is documented in
// extractor-screen.js and SECURITY.md rather than implied away. What this
// module buys is closing every bypass that works by NAMING the dangerous
// thing through an alias, which is the entire class the regex screen turned
// out to miss.

import { parse } from 'acorn';
import { ancestor as walkAncestor } from 'acorn-walk';

// Objects whose IDENTITY is itself dangerous to hold onto — anything reached
// through one of these (directly or via chained aliasing) is global reach.
const GLOBAL_OBJECT_NAMES = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);

// Other bare names that are never legitimate in a DOM-reading extractor,
// regardless of aliasing.
const BANNED_BARE_NAMES = new Set([
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'chrome', 'Worker', 'importScripts',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'setTimeout', 'setInterval', 'requestIdleCallback',
  'Reflect'
]);

// Member names on a global-identity object that themselves yield another
// global-identity object — the only property names an alias's "global-ness"
// propagates through. Anything else pulled off a global (e.g. `.document`,
// `.innerWidth`) is ordinary and not itself dangerous to hold a reference to.
const GLOBAL_YIELDING_PROPS = new Set(['top', 'parent', 'self', 'window', 'frames', 'defaultView']);

// Member names that ARE a capability worth naming as its own alias category —
// holding one of these under any name and later calling it is the same as
// calling it directly.
const CAPABILITY_PROPS = new Set(['fetch', 'eval']);

function isIdentifier(node, name) {
  return !!node && node.type === 'Identifier' && node.name === name;
}

// True if `node` denotes something with the IDENTITY of window/self/
// globalThis/top/parent/frames/this — directly, via a tracked alias, or via a
// chain of global-yielding property access (`w.top.frames`).
function resolvesToGlobalIdentity(node, globalAliases) {
  if (!node) return false;
  if (node.type === 'ThisExpression') return true;
  if (node.type === 'Identifier') {
    return GLOBAL_OBJECT_NAMES.has(node.name) || globalAliases.has(node.name);
  }
  if (node.type === 'MemberExpression') {
    const propName = !node.computed && node.property.type === 'Identifier'
      ? node.property.name
      : (node.computed && node.property.type === 'Literal' ? String(node.property.value) : null);
    return propName != null && GLOBAL_YIELDING_PROPS.has(propName) && resolvesToGlobalIdentity(node.object, globalAliases);
  }
  return false;
}

// True if `node` denotes the `document` object — the bare identifier, a
// tracked alias of it, or `.document` pulled off anything that resolves to a
// window-like global (`w.document`, `window.top.document`, …). Kept separate
// from resolvesToGlobalIdentity because `document` itself is NOT
// window-identity (an extractor legitimately holds and re-derives `document`
// constantly) — only specific member accesses on it (`.cookie`, `.write`)
// are dangerous, so this needs its own alias category rather than folding
// into the window-alias set.
function resolvesToDocumentIdentity(node, globalAliases, documentAliases) {
  if (!node) return false;
  if (isIdentifier(node, 'document')) return true;
  if (node.type === 'Identifier') return documentAliases.has(node.name);
  if (node.type === 'MemberExpression') {
    const propName = !node.computed && node.property.type === 'Identifier'
      ? node.property.name
      : (node.computed && node.property.type === 'Literal' ? String(node.property.value) : null);
    return propName === 'document' && resolvesToGlobalIdentity(node.object, globalAliases);
  }
  return false;
}

// A MemberExpression property name, whether written as `.name` or `["name"]`
// with a literal key. Returns null for a genuinely dynamic (non-literal) key.
function staticPropName(memberExpr) {
  if (memberExpr.type !== 'MemberExpression') return null;
  if (!memberExpr.computed && memberExpr.property.type === 'Identifier') return memberExpr.property.name;
  if (memberExpr.computed && memberExpr.property.type === 'Literal') return String(memberExpr.property.value);
  return null;
}

function isObjectDotName(node, objectName, propName) {
  return node.type === 'MemberExpression' && isIdentifier(node.object, objectName) && staticPropName(node) === propName;
}

// Does `init` hand the assignee a CAPABILITY (fetch/eval), by any of the
// concrete routes actually seen in the wild? Kept to specific, verified
// shapes rather than generalized — a name-based static check cannot be made
// exhaustive, only progressively harder to slip past (see file header).
function grantsCapability(init, globalAliases, capabilityAliases) {
  if (!init) return false;
  // window.fetch / w.fetch (w a tracked global alias) / bare fetch,eval
  if (isIdentifier(init, 'fetch') || isIdentifier(init, 'eval')) return true;
  if (init.type === 'MemberExpression') {
    const prop = staticPropName(init);
    if (prop && CAPABILITY_PROPS.has(prop) && resolvesToGlobalIdentity(init.object, globalAliases)) return true;
  }
  if (init.type === 'CallExpression') {
    // Reflect.get(X, "fetch"|"eval")
    if (isObjectDotName(init.callee, 'Reflect', 'get') && init.arguments.length >= 2) {
      const key = init.arguments[1];
      if (key.type === 'Literal' && CAPABILITY_PROPS.has(key.value)) return true;
    }
  }
  // Object.getOwnPropertyDescriptor(X, "fetch"|"eval").value
  if (init.type === 'MemberExpression' && staticPropName(init) === 'value'
      && init.object.type === 'CallExpression'
      && isObjectDotName(init.object.callee, 'Object', 'getOwnPropertyDescriptor')
      && init.object.arguments.length >= 2) {
    const key = init.object.arguments[1];
    if (key.type === 'Literal' && CAPABILITY_PROPS.has(key.value)) return true;
  }
  // Identifier that is ITSELF already a tracked capability alias.
  if (init.type === 'Identifier' && capabilityAliases.has(init.name)) return true;
  return false;
}

const ENUMERATION_FNS = new Set(['values', 'entries', 'keys', 'getOwnPropertyNames', 'getPrototypeOf']);

export function screenExtractorSourceAst(src) {
  if (typeof src !== 'string' || !src.trim()) {
    // The text screen already rejects empty/non-string input with a clearer
    // message; nothing useful to add here.
    return { ok: true };
  }
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (e) {
    return { ok: false, reason: `source is not valid JavaScript: ${e.message}` };
  }

  // Pass 1 — seed alias sets. Iterated to a fixed point so a multi-hop chain
  // (`var a=window; var b=a; var c=b.fetch;`) resolves regardless of the
  // order declarations happen to appear in.
  const globalAliases = new Set();
  const capabilityAliases = new Set();
  const documentAliases = new Set();
  const hits = new Set();
  const flag = (why) => hits.add(why);
  const seed = (name, init) => {
    if (resolvesToGlobalIdentity(init, globalAliases)) globalAliases.add(name);
    if (resolvesToDocumentIdentity(init, globalAliases, documentAliases)) documentAliases.add(name);
    if (grantsCapability(init, globalAliases, capabilityAliases)) capabilityAliases.add(name);
  };
  // Destructuring (`var {fetch: f} = window;`) is renaming by another syntax
  // — the plain-identifier check below (`node.name === 'fetch'`) never sees
  // the local name `f` at all, so this needs its own handling rather than
  // falling out of `seed` for free.
  const seedDestructure = (pattern, source) => {
    if (pattern.type === 'ObjectPattern') {
      const isGlobal = resolvesToGlobalIdentity(source, globalAliases);
      const isDocument = resolvesToDocumentIdentity(source, globalAliases, documentAliases);
      if (!isGlobal && !isDocument) return;
      for (const prop of pattern.properties) {
        if (prop.type !== 'Property' || prop.value.type !== 'Identifier') continue;
        const keyName = !prop.computed && prop.key.type === 'Identifier' ? prop.key.name
          : (prop.computed && prop.key.type === 'Literal' ? String(prop.key.value) : null);
        if (keyName == null) continue;
        if (isGlobal) {
          if (GLOBAL_YIELDING_PROPS.has(keyName)) globalAliases.add(prop.value.name);
          if (keyName === 'document') documentAliases.add(prop.value.name);
          if (CAPABILITY_PROPS.has(keyName)) capabilityAliases.add(prop.value.name);
        }
        // Destructuring `cookie` out of document is the read itself — the
        // violation is complete right here, regardless of what happens to the
        // local name afterward.
        if (isDocument && keyName === 'cookie') {
          flag('credential access (document.cookie), reached via destructuring');
        }
      }
      return;
    }
    // Array destructuring paired with an array-literal source —
    // `var [w] = [window];` — the same rename-by-syntax trick, positional
    // instead of named. Only handled for a literal array on the RHS: without
    // one there is no static per-slot identity to pair against.
    if (pattern.type === 'ArrayPattern' && source.type === 'ArrayExpression') {
      pattern.elements.forEach((el, i) => {
        if (!el || el.type !== 'Identifier') return;
        const value = source.elements[i];
        if (value) seed(el.name, value);
      });
    }
  };
  for (let round = 0; round < 6; round++) {
    const before = globalAliases.size + capabilityAliases.size + documentAliases.size;
    walkAncestor(ast, {
      VariableDeclarator(node) {
        if (!node.init) return;
        if (node.id.type === 'Identifier') seed(node.id.name, node.init);
        else seedDestructure(node.id, node.init);
      },
      AssignmentExpression(node) {
        if (node.operator !== '=') return;
        if (node.left.type === 'Identifier') seed(node.left.name, node.right);
        else seedDestructure(node.left, node.right);
      },
      // Parameter binding is the same aliasing trick one level removed:
      // `(function(w){ ... w.fetch ... })(window)` never assigns `w` with
      // `=`, but calling the function hands it the same identity. Treated
      // flatly (no real per-call scoping) — an over-approximation, but the
      // failure mode of over-tainting a name is a false positive, which this
      // file's whole policy already treats as cheap.
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'FunctionExpression' && callee.type !== 'ArrowFunctionExpression') return;
        callee.params.forEach((param, i) => {
          if (param.type !== 'Identifier') return;
          const arg = node.arguments[i];
          if (arg) seed(param.name, arg);
        });
      }
    });
    if (globalAliases.size + capabilityAliases.size + documentAliases.size === before) break; // fixed point
  }

  // Pass 2 — scan for violations using the final alias sets (`hits`/`flag`
  // declared above so destructuring's direct cookie-read check in Pass 1
  // could feed the same set).
  walkAncestor(ast, {
    ThisExpression() {
      flag('reference to `this` — resolves to the global object here and is not needed to read the DOM');
    },
    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      // A bare Identifier that is really just a non-computed property NAME
      // (`obj.fetch`) or an object-literal key (`{fetch: 1}`) is not a
      // variable reference at all — skip it, or "fetch" used as an ordinary
      // data field name would falsely trip the screen.
      if (parent) {
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      }
      if (BANNED_BARE_NAMES.has(node.name)) {
        flag(`reference to ${node.name} — not available to a DOM-reading extractor`);
      } else if (node.name === 'fetch' || node.name === 'eval') {
        flag(`reference to ${node.name} — network/dynamic-code access`);
      } else if (node.name === 'Function') {
        flag('reference to Function — dynamic code generation');
      } else if (capabilityAliases.has(node.name) && parent && parent.type === 'CallExpression' && parent.callee === node) {
        flag(`call through an alias of a network/eval capability (\`${node.name}\`)`);
      }
    },
    MemberExpression(node) {
      const prop = staticPropName(node);
      if (prop === 'constructor') {
        flag('prototype-chain access (.constructor) — a common sandbox-escape route');
        return;
      }
      if (node.computed && node.property.type !== 'Literal'
          && (resolvesToGlobalIdentity(node.object, globalAliases)
            || resolvesToDocumentIdentity(node.object, globalAliases, documentAliases))) {
        if (node.property.type === 'BinaryExpression') {
          flag('dynamic (computed, string concatenation) property access on a global object');
        } else {
          flag('dynamic (computed, non-literal) property access on a global object');
        }
        return;
      }
      // X.fetch / X["fetch"] / X.eval / X["eval"] reached via an alias — the
      // text screen only sees this when "fetch(" or "window[" appear
      // verbatim, so `var w = window; w["fetch"](...)` (literal bracket key,
      // aliased base) is invisible to it. Checked here directly rather than
      // only at the point of use, so it fires whether or not the result is
      // ever stored in a variable first.
      if ((prop === 'fetch' || prop === 'eval') && resolvesToGlobalIdentity(node.object, globalAliases)) {
        flag(`reference to ${prop}, reached via an alias — network/dynamic-code access`);
      }
      if (prop === 'cookie' && resolvesToDocumentIdentity(node.object, globalAliases, documentAliases)) {
        flag('credential access (document.cookie), reached via an alias');
      }
      if ((prop === 'sendBeacon') && isIdentifier(node.object, 'navigator')) {
        flag('network access (sendBeacon)');
      }
      if (prop === 'credentials' && isIdentifier(node.object, 'navigator')) {
        flag('credential access (Credential Management)');
      }
      if ((prop === 'click' || prop === 'submit')) {
        flag('page interaction — an extractor reads, it does not act');
      }
      if (prop === 'write' && resolvesToDocumentIdentity(node.object, globalAliases, documentAliases)) {
        flag('page mutation (document.write), reached via an alias');
      }
      if ((prop === 'open' || prop === 'location') && resolvesToGlobalIdentity(node.object, globalAliases)) {
        flag('navigation (window.open / window.location), reached via an alias');
      }
      if (prop === 'sendMessage' || (node.object.type === 'Identifier' && node.object.name === 'chrome')) {
        // already covered by the bare-name check on `chrome`, kept here only
        // for the alias-reached shape symmetry — no separate action needed.
      }
    },
    CallExpression(node) {
      const calleeProp = node.callee.type === 'MemberExpression' ? staticPropName(node.callee) : null;
      const calleeObjIsObject = node.callee.type === 'MemberExpression' && isIdentifier(node.callee.object, 'Object');
      const calleeObjIsReflect = node.callee.type === 'MemberExpression' && isIdentifier(node.callee.object, 'Reflect');
      if (calleeObjIsObject && calleeProp === 'getOwnPropertyDescriptor') {
        flag('property descriptor introspection — can retrieve arbitrary globals by name');
      }
      if (calleeObjIsObject && calleeProp === 'getOwnPropertyDescriptors') {
        flag('property descriptor introspection — can retrieve arbitrary globals by name');
      }
      if (calleeObjIsReflect) {
        flag('reflection API access (Reflect.*) — can retrieve arbitrary globals by name');
      }
      if (calleeObjIsObject && ENUMERATION_FNS.has(calleeProp) && node.arguments.length
          && (resolvesToGlobalIdentity(node.arguments[0], globalAliases)
            || resolvesToDocumentIdentity(node.arguments[0], globalAliases, documentAliases))) {
        flag(`enumeration of a global object's own properties (Object.${calleeProp}) — can discover a capability without naming it`);
      }
      if (isIdentifier(node.callee, 'postMessage')
          || (node.callee.type === 'MemberExpression' && staticPropName(node.callee) === 'postMessage')) {
        flag('cross-context messaging (postMessage)');
      }
      if (isIdentifier(node.callee, 'Function')) {
        flag('dynamic code generation (Function constructor)');
      }
    }
  });

  if (hits.size) return { ok: false, reason: [...hits].join('; ') };
  return { ok: true };
}
