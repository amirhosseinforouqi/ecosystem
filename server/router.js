'use strict';

const { ApiError } = require('./util');

/**
 * Minimal router: METHOD + /path/with/:params → handler chain.
 * Handlers receive a ctx object and either return a JSON-serializable value
 * or write to ctx.res directly (streams) and return ctx.HANDLED.
 */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, ...handlers) {
    const names = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((part) => {
            if (part.startsWith(':')) {
              names.push(part.slice(1));
              return '([^/]+)';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '$'
    );
    this.routes.push({ method, regex, names, handlers, rawBody: false, pattern });
    return this;
  }

  /** Mark the most recently added route as receiving a raw (streamed) body. */
  raw() {
    this.routes[this.routes.length - 1].rawBody = true;
    return this;
  }

  get(pattern, ...handlers) { return this.add('GET', pattern, ...handlers); }
  post(pattern, ...handlers) { return this.add('POST', pattern, ...handlers); }
  put(pattern, ...handlers) { return this.add('PUT', pattern, ...handlers); }
  patch(pattern, ...handlers) { return this.add('PATCH', pattern, ...handlers); }
  delete(pattern, ...handlers) { return this.add('DELETE', pattern, ...handlers); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.names.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { route, params };
    }
    return null;
  }
}

const HANDLED = Symbol('handled');

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new ApiError(413, 'The request was too large.', 'too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'The request body was not valid JSON.', 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { Router, HANDLED, readJsonBody };
