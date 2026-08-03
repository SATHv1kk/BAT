// Accessibility-tree serialiser — the model's only view of a page.
//
// Injected into EVERY frame at document_start as a CLASSIC content script
// (manifest content_scripts, plus on-demand injection from the panel via
// `?script`). It must therefore stay a plain IIFE with no imports and no
// module syntax: there is no bundler pass on the injected form, and an ESM
// `import` would fail to load in the isolated world.
//
// Output is one indented line per element, e.g.
//   textbox "Email" [ref_12] type="email" placeholder="you@example.com"
//    option "Ireland" (selected) value="IE"
// The [ref_N] tokens are the only handles the model ever gets on the DOM;
// click/type/select all resolve them through window.__batElementMap.
(function () {
  // Refs must stay valid across repeated read_page calls in the same document,
  // so the maps live on window and are initialised once per frame. WeakRef /
  // WeakMap so serialising an element never keeps a detached node alive.
  if (!window.__batElementMap) window.__batElementMap = {};                          // ref -> WeakRef(element)
  if (!window.__batElementReverseMap) window.__batElementReverseMap = new WeakMap();  // element -> ref
  if (!window.__batRefCounter) window.__batRefCounter = 0;

  // MIRROR of src/lib/redaction.js — keep in sync; tested there.
  // Duplicated (not imported) only because a classic content script cannot
  // import an ES module. Any change here must be made there too.
  var SENSITIVE_AUTOCOMPLETE = [
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year'
  ];
  var REDACTED = '[value redacted]';

  // Substring (not equality) match on autocomplete: real forms ship space-
  // separated and section-prefixed tokens like "section-billing cc-number".
  function isSensitiveField(type, autocomplete) {
    if (type === 'password' || type === 'hidden') return true;
    for (var i = 0; i < SENSITIVE_AUTOCOMPLETE.length; i++) {
      if (autocomplete.indexOf(SENSITIVE_AUTOCOMPLETE[i]) !== -1) return true;
    }
    return false;
  }

  // DOM adapter over the mirrored policy above.
  function isSensitive(el) {
    return isSensitiveField(
      (el.getAttribute('type') || '').toLowerCase(),
      (el.getAttribute('autocomplete') || '').toLowerCase()
    );
  }

  var ELEMENT_CAP = 10000;
  var DEFAULT_DEPTH = 15;
  var NAME_MAX = 100;

  // Roles the model can reason about. An explicit role attribute always wins;
  // otherwise the tag (and for <input>, its type) decides.
  function getRole(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;

    var tag = el.tagName.toLowerCase();
    var type = el.getAttribute('type');

    return {
      a: 'link',
      button: 'button',
      input: type === 'submit' || type === 'button' ? 'button'
        : type === 'checkbox' ? 'checkbox'
        : type === 'radio' ? 'radio'
        // A file picker behaves like a button to the model — it cannot type into it.
        : type === 'file' ? 'button'
        : 'textbox',
      select: 'combobox',
      textarea: 'textbox',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      img: 'image',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      section: 'region',
      article: 'article',
      aside: 'complementary',
      form: 'form',
      table: 'table',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      label: 'label'
    }[tag] || 'generic';
  }

  // This element's OWN text only. Using textContent instead would make every
  // wrapper <div> inherit the whole subtree's text.
  function directText(el) {
    var text = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === Node.TEXT_NODE) text += el.childNodes[i].textContent;
    }
    return text.trim();
  }

  function labelForText(el) {
    if (!el.id) return '';
    var labelEl = document.querySelector('label[for="' + el.id + '"]');
    if (!labelEl) return '';
    return directText(labelEl);
  }

  // A sensitive <select> still needs a findable name, but it must never come
  // from the selected option — that option IS the secret.
  function sensitiveSelectName(el) {
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    var labelText = labelForText(el);
    if (labelText) return labelText;
    return REDACTED;
  }

  // Accessible name, resolved in descending order of author intent:
  // aria-label > placeholder > title > alt > <label for> > element-specific
  // (value / own text) > own text fallback.
  function getAccessibleName(el) {
    var tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      if (isSensitive(el)) return sensitiveSelectName(el);
      // querySelector first so a server-rendered `selected` attribute wins over
      // whatever the browser defaulted selectedIndex to.
      var selected = el.querySelector('option[selected]') || el.options[el.selectedIndex];
      if (selected && selected.textContent) return selected.textContent.trim();
      // No option text: fall through to the generic resolution below.
    }

    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    var placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    var alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    var labelText = labelForText(el);
    if (labelText) return labelText;

    if (tag === 'input') {
      var type = el.getAttribute('type') || '';
      var valueAttr = el.getAttribute('value');
      // A submit button's label IS its value attribute.
      if (type === 'submit' && valueAttr && valueAttr.trim()) return valueAttr.trim();
      // Sensitive input: report only WHETHER it is filled, never with what.
      if (isSensitive(el)) return el.value ? REDACTED : '';
      // Short live values orient the model in a half-filled form; long ones are
      // pasted prose that would bloat the tree.
      if (el.value && el.value.length < 50 && el.value.trim()) return el.value.trim();
    }

    if (tag === 'textarea' && isSensitive(el)) return el.value ? REDACTED : '';

    if (['button', 'a', 'summary'].includes(tag)) {
      var ownText = directText(el);
      if (ownText) return ownText;
    }

    if (tag.match(/^h[1-6]$/)) {
      // Headings are the page's outline, so the full subtree text is wanted here
      // even though it is truncated hard.
      var headingText = el.textContent;
      if (headingText && headingText.trim()) return headingText.trim().substring(0, NAME_MAX);
    }

    // An unlabelled <img> is decorative; naming it from nearby text would lie.
    if (tag === 'img') return '';

    // Last resort. The >= 3 floor drops stray punctuation and single-character
    // separators that would otherwise name half the generic containers.
    var text = directText(el);
    if (text.length >= 3) {
      return text.length > NAME_MAX ? text.substring(0, NAME_MAX) + '...' : text;
    }

    return '';
  }

  // Cheap approximation of "the user can see this". offsetWidth/Height also
  // catches ancestors with display:none without walking up the tree.
  function isVisible(el) {
    var style = window.getComputedStyle(el);
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0;
  }

  // Anything the model could plausibly act on. Deliberately generous: a div with
  // onclick/tabindex/role is how most component libraries build buttons.
  function isInteractive(el) {
    var tag = el.tagName.toLowerCase();
    return ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag) ||
      el.getAttribute('onclick') !== null ||
      el.getAttribute('tabindex') !== null ||
      el.getAttribute('role') === 'button' ||
      el.getAttribute('role') === 'link' ||
      el.getAttribute('contenteditable') === 'true';
  }

  // Structure worth keeping even when not interactive, so the model can tell
  // "the nav" from "the results list".
  function isLandmark(el) {
    var tag = el.tagName.toLowerCase();
    return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside'].includes(tag) ||
      el.getAttribute('role') !== null;
  }

  function shouldInclude(el, ctx) {
    var tag = el.tagName.toLowerCase();
    if (['script', 'style', 'meta', 'link', 'title', 'noscript'].includes(tag)) return false;

    // filter === 'all' is the debug/whole-document mode: no hiding heuristics at
    // all, because the point of it is to explain why something went missing.
    if (ctx.filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
    if (ctx.filter !== 'all' && !isVisible(el)) return false;

    // Off-screen content is dropped so a long page reads as what the user is
    // actually looking at — but never when the caller scoped the read to a
    // refId, since that element may well be below the fold.
    if (ctx.filter !== 'all' && !ctx.refId) {
      var rect = el.getBoundingClientRect();
      var intersectsViewport = rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0;
      if (!intersectsViewport) return false;
    }

    if (ctx.filter === 'interactive') return isInteractive(el);

    if (isInteractive(el)) return true;
    if (isLandmark(el)) return true;
    if (getAccessibleName(el).length > 0) return true;

    // Keep anything with a meaningful role; 'generic' and bare images carry no
    // information the model can use.
    var role = getRole(el);
    return role !== null && role !== 'generic' && role !== 'image';
  }

  /**
   * @param {'all'|'interactive'|string} [filter]
   * @param {number} [depth]     max tree depth (default 15)
   * @param {number} [maxChars]  refuse to return output longer than this
   * @param {string} [refId]     read only this previously returned ref's subtree
   * @returns {{pageContent: string, viewport: {width: number, height: number}}
   *          | {error: string, pageContent: '', viewport: {width: number, height: number}}}
   */
  window.__generateAccessibilityTree = function (filter, depth, maxChars, refId) {
    try {
      var lines = [];
      var maxDepth = depth != null ? depth : DEFAULT_DEPTH;
      var count = 0;
      var ctx = { filter: filter || 'all', refId: refId };

      function viewport() {
        return { width: window.innerWidth, height: window.innerHeight };
      }

      function walk(el, level) {
        // Stop at the caps before doing any per-element work.
        if (count >= ELEMENT_CAP) return;
        if (level > maxDepth) return;
        if (!el || !el.tagName) return;

        // A refId-scoped read always emits its own root: the caller asked for
        // that element by name, so filtering it out would return nothing.
        // NOTE: refId is `undefined` (not null) on a whole-page read, so the
        // strict !== null also force-includes <body> at level 0. Intentional —
        // it guarantees the tree always has a root line.
        var included = shouldInclude(el, ctx) || (ctx.refId !== null && level === 0);

        if (included) {
          var tag = el.tagName.toLowerCase();
          var name = getAccessibleName(el);

          // Reuse the ref already handed to the model for this element so refs
          // it saw in an earlier read keep resolving. The WeakRef re-check
          // catches a reverse-map entry whose forward entry was swept or
          // reassigned, and forces a fresh ref in that case.
          var ref = window.__batElementReverseMap.get(el) || null;
          if (ref) {
            var existing = window.__batElementMap[ref];
            if (!existing || existing.deref() !== el) ref = null;
          }
          if (!ref) {
            ref = 'ref_' + (++window.__batRefCounter);
            window.__batElementMap[ref] = new WeakRef(el);
            window.__batElementReverseMap.set(el, ref);
            try { el.setAttribute('data-ext-ref', ref); } catch (attrErr) {}
          }
          count++;

          var line = ' '.repeat(level) + tag;
          var explicitRole = el.getAttribute('role');
          if (explicitRole && explicitRole !== tag) line += ' role="' + explicitRole + '"';
          if (name) {
            name = name.replace(/\s+/g, ' ').substring(0, NAME_MAX);
            line += ' "' + name.replace(/"/g, '\\"') + '"';
          }
          line += ' [' + ref + ']';
          // Attributes the model needs to decide what a control does OR
          // to write extractor function_source without DOM exploration rounds.
          if (el.getAttribute('href')) line += ' href="' + el.getAttribute('href').replace(/"/g, '\\"') + '"';
          if (el.getAttribute('type')) line += ' type="' + el.getAttribute('type').replace(/"/g, '\\"') + '"';
          if (el.getAttribute('placeholder')) line += ' placeholder="' + el.getAttribute('placeholder').replace(/"/g, '\\"') + '"';
          var dataAt = el.getAttribute('data-at');
          if (dataAt) line += ' data-at="' + dataAt.replace(/"/g, '\\"') + '"';
          var dataTestId = el.getAttribute('data-testid');
          if (dataTestId) line += ' data-testid="' + dataTestId.replace(/"/g, '\\"') + '"';
          var elId = el.getAttribute('id');
          if (elId) line += ' id="' + elId.replace(/"/g, '\\"') + '"';
          var className = (el.getAttribute('class') || '').trim();
          // Only worth the token when it's not a random hash (res-xxxx React class).
          var meaningful = className.replace(/\bres-[a-z0-9]+\b/gi, '').trim();
          if (meaningful) line += ' class="' + meaningful.replace(/"/g, '\\"') + '"';
          lines.push(line);

          // Enumerate options so select_option can be called with a valid value
          // without another round trip. NOT for a sensitive select: its option
          // list is the value space of a secret.
          if (el.tagName.toLowerCase() === 'select' && !isSensitive(el)) {
            var options = el.options;
            for (var o = 0; o < options.length; o++) {
              var option = options[o];
              var optionLine = ' '.repeat(level + 1) + 'option';
              var text = option.textContent ? option.textContent.trim() : '';
              if (text) {
                text = text.replace(/\s+/g, ' ').substring(0, NAME_MAX);
                optionLine += ' "' + text.replace(/"/g, '\\"') + '"';
              }
              if (option.selected) optionLine += ' (selected)';
              // Only worth a token when the value differs from the label the
              // model just read (compared post-collapse/truncation).
              if (option.value && option.value !== text) {
                optionLine += ' value="' + option.value.replace(/"/g, '\\"') + '"';
              }
              lines.push(optionLine);
            }
          }
        }

        // Never descend into a sensitive <select> — its children are the values.
        var sensitiveSelect = el.tagName.toLowerCase() === 'select' && isSensitive(el);
        if (!sensitiveSelect && level < maxDepth) {
          if (el.children) {
            for (var c = 0; c < el.children.length; c++) {
              // Indent only advances past elements we actually emitted, so layout
              // wrapper divs do not push the whole tree to the right.
              walk(el.children[c], included ? level + 1 : level);
            }
          }
          // An OPEN shadow root hosts its own child tree that a plain
          // el.children walk never sees — increasingly common in component
          // libraries (Web Components, many design systems' custom elements).
          // Without this, every control inside one is silently invisible: not
          // filtered out, just never reached. A CLOSED shadow root has no
          // JS-reachable API at all (that is the point of "closed"); nothing
          // short of CDP's Accessibility domain can see inside one.
          if (el.shadowRoot && el.shadowRoot.children) {
            for (var sc = 0; sc < el.shadowRoot.children.length; sc++) {
              walk(el.shadowRoot.children[sc], included ? level + 1 : level);
            }
          }
        }
      }

      if (refId) {
        var entry = window.__batElementMap[refId];
        if (!entry) {
          return {
            error: "Element with ref_id '" + refId + "' not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.",
            pageContent: '',
            viewport: viewport()
          };
        }
        var root = entry.deref();
        if (!root) {
          return {
            error: "Element with ref_id '" + refId + "' no longer exists. It may have been removed from the page. Use read_page without ref_id to get the current page state.",
            pageContent: '',
            viewport: viewport()
          };
        }
        walk(root, 0);
      } else if (document.body) {
        // At document_start there may be no body yet; an empty tree is correct.
        walk(document.body, 0);
      }

      // Sweep refs whose elements have been collected, so the map does not grow
      // without bound over the life of a long-running tab.
      for (var staleRef in window.__batElementMap) {
        if (!window.__batElementMap[staleRef].deref()) delete window.__batElementMap[staleRef];
      }

      var pageContent = lines.join('\n');

      if (count >= ELEMENT_CAP) {
        pageContent += '\n[truncated at ' + ELEMENT_CAP + ' elements — page is very large; ' +
          (refId
            ? 'use a smaller depth or focus on a more specific child element'
            : 'use a refId or smaller depth to focus') +
          ']';
      }

      // Over budget: return the error INSTEAD of the content. Handing back a
      // truncated tree would have the model click refs from a half-read page.
      if (maxChars != null && pageContent.length > maxChars) {
        var error = 'Output exceeds ' + maxChars + ' character limit (' + pageContent.length + ' characters). ';
        if (refId) {
          error += 'The specified element has too much content. Try specifying a smaller depth parameter or focus on a more specific child element.';
        } else if (depth !== undefined) {
          // `!== undefined`, not `!= null`: an explicit `depth: null` still means
          // the caller knows about the parameter, so it gets the tighter advice.
          error += 'Try specifying an even smaller depth parameter or use ref_id to focus on a specific element.';
        } else {
          error += 'Try specifying a depth parameter (e.g., depth: 5) or use ref_id to focus on a specific element from the page.';
        }
        return { error: error, pageContent: '', viewport: viewport() };
      }

      return { pageContent: pageContent, viewport: viewport() };
    } catch (err) {
      throw new Error('Error generating accessibility tree: ' + (err.message || 'Unknown error'));
    }
  };
})();
