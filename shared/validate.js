/*
 * shared/validate.js — single source of truth for the variable schema.
 *
 * Loaded BOTH ways with no build step:
 *   - server: `const V = require('./shared/validate.js')`  (CommonJS)
 *   - client: `<script src="/shared/validate.js"></script>` then `window.VBValidate`
 *
 * Keeping coercion/validation here (not duplicated in the client and server)
 * is what stops client and server from silently disagreeing about what a
 * "valid variable" is once several stakeholders are writing to one list.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;            // server (CommonJS)
  } else {
    root.VBValidate = api;           // browser (global)
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The six types the editor supports. Anything else is coerced to 'string'.
  const VALID_TYPES = ['string', 'integer', 'decimal', 'color', 'image', 'select'];

  // display_name -> id. Mirrors the original tool's behaviour exactly.
  function toSnakeCase(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  const HEX6 = /^#[0-9a-fA-F]{6}$/;

  function isPlainObject(x) {
    return x != null && typeof x === 'object' && !Array.isArray(x);
  }

  // Coerce one select option to { id, value, name } strings, dropping junk.
  function coerceOption(o) {
    if (!isPlainObject(o)) return { id: '', value: '', name: '' };
    return {
      id: o.id == null ? '' : String(o.id),
      value: o.value == null ? '' : String(o.value),
      name: o.name == null ? '' : String(o.name),
    };
  }

  /*
   * Normalise a single raw variable into the canonical shape.
   * Defensive on purpose: `raw` may come from another contributor's browser,
   * a hand-edited import file, or a malicious payload.
   *   - unknown `type`            -> 'string'
   *   - non-boolean overridable   -> Boolean()
   *   - integer/decimal defaults  -> real numbers when they parse
   *   - type_config only kept for 'select', always shaped to {options:[...]}
   *   - strips prototype-pollution keys (__proto__, constructor, prototype)
   */
  function coerceVariable(raw) {
    const src = isPlainObject(raw) ? raw : {};

    let type = typeof src.type === 'string' ? src.type : 'string';
    if (VALID_TYPES.indexOf(type) === -1) type = 'string';

    const display_name = src.display_name == null ? '' : String(src.display_name);

    // Prefer an explicit id; otherwise derive from display_name.
    let id = src.id == null || src.id === '' ? toSnakeCase(display_name) : String(src.id);

    let default_value = src.default_value == null ? '' : src.default_value;
    if (type === 'integer' || type === 'decimal') {
      default_value = coerceNumber(default_value, type);
    } else {
      default_value = String(default_value);
    }

    const out = {
      id,
      display_name,
      default_value,
      is_overridable: src.is_overridable === undefined ? true : Boolean(src.is_overridable),
      type,
      category: src.category == null ? '' : String(src.category),
      // editor-side "pick" marker: persisted to the store and synced between
      // collaborators, but deliberately omitted from toExport() so it never
      // leaks into the generated variable JSON.
      flag: src.flag === true,
    };

    if (type === 'select') {
      const opts = isPlainObject(src.type_config) && Array.isArray(src.type_config.options)
        ? src.type_config.options.map(coerceOption)
        : [];
      out.type_config = { options: opts };
    }

    return out;
  }

  // "16" -> 16, "1.5" -> 1.5, "" -> "", "abc" -> "" (invalid → empty, surfaced
  // as an error by validateVariable; never leaks a string where a number is due).
  function coerceNumber(v, type) {
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (s === '') return '';
    const n = type === 'integer' ? parseInt(s, 10) : parseFloat(s);
    return Number.isNaN(n) ? '' : n;
  }

  /*
   * Build the export/storage object for a variable — omits empty category and
   * omits type_config for non-select, matching the original buildJson().
   */
  function toExport(v) {
    const c = coerceVariable(v);
    const obj = {
      id: c.id,
      display_name: c.display_name,
      default_value: c.default_value,
      is_overridable: c.is_overridable,
      type: c.type,
    };
    if (c.category && c.category.trim()) obj.category = c.category.trim();
    if (c.type === 'select') obj.type_config = c.type_config;
    return obj;
  }

  /*
   * Make every id in a list unique and non-empty, in place-ish (returns a new
   * array of ids aligned to input order). Empty ids get a positional fallback;
   * collisions get _2, _3 suffixes. This is what prevents two "Accent Color"
   * rows from silently sharing one id.
   */
  function ensureUniqueIds(list) {
    const seen = new Map();
    return list.map((v, i) => {
      let base = (v && v.id ? String(v.id) : '') || toSnakeCase(v && v.display_name) || `var_${i + 1}`;
      let id = base;
      let n = 2;
      while (seen.has(id)) { id = `${base}_${n++}`; }
      seen.set(id, true);
      return id;
    });
  }

  /*
   * Validate a coerced variable. Returns array of { field, level, message }.
   * level: 'error' blocks export/save; 'warn' is advisory.
   */
  function validateVariable(v) {
    const problems = [];
    const c = coerceVariable(v);

    if (!c.display_name.trim()) {
      problems.push({ field: 'display_name', level: 'error', message: 'Display name is required.' });
    }
    if (!c.id) {
      problems.push({ field: 'id', level: 'error', message: 'Could not derive an id (display name has no letters/digits).' });
    }
    if (c.type === 'integer' || c.type === 'decimal') {
      if (c.default_value !== '' && typeof c.default_value !== 'number') {
        problems.push({ field: 'default_value', level: 'error', message: `Not a valid ${c.type}.` });
      }
    }
    if (c.type === 'color') {
      if (c.default_value && !HEX6.test(c.default_value)) {
        problems.push({ field: 'default_value', level: 'warn', message: 'Expected a #rrggbb hex colour.' });
      }
    }
    if (c.type === 'image') {
      if (c.default_value && !/^https?:\/\/|^data:image\//i.test(c.default_value)) {
        problems.push({ field: 'default_value', level: 'warn', message: 'Expected an http(s) or data: image URL.' });
      }
    }
    if (c.type === 'select') {
      const opts = c.type_config.options;
      if (opts.length === 0) {
        problems.push({ field: 'type_config', level: 'warn', message: 'Select has no options.' });
      }
      const ids = new Set();
      opts.forEach((o, i) => {
        if (!o.id.trim()) problems.push({ field: `option[${i}].id`, level: 'warn', message: 'Option id is empty.' });
        else if (ids.has(o.id)) problems.push({ field: `option[${i}].id`, level: 'error', message: `Duplicate option id "${o.id}".` });
        else ids.add(o.id);
      });
    }
    return problems;
  }

  // Validate a whole list; also reports cross-row duplicate ids as errors.
  function validateList(list) {
    const perVar = list.map(validateVariable);
    const idCounts = new Map();
    list.forEach(v => {
      const id = coerceVariable(v).id;
      if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
    });
    list.forEach((v, i) => {
      const id = coerceVariable(v).id;
      if (id && idCounts.get(id) > 1) {
        perVar[i].push({ field: 'id', level: 'error', message: `Duplicate id "${id}" (used by ${idCounts.get(id)} variables).` });
      }
    });
    return perVar;
  }

  return {
    VALID_TYPES,
    toSnakeCase,
    coerceVariable,
    coerceOption,
    coerceNumber,
    toExport,
    ensureUniqueIds,
    validateVariable,
    validateList,
    isPlainObject,
    HEX6,
  };
});
