/**
 * DEPRECATED — Re-exports from category handler files.
 * Import directly from http/handler, browser/handler, search/handler instead.
 */

export { handleHttp } from "./http/handler.js";
export { handleBrowser } from "./browser/handler.js";
export { handleSearch, ensureEverythingSearch, BOT_ES_PATH } from "./search/handler.js";
