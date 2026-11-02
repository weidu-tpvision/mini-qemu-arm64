// fs_shim.js - Browser shim for node:fs module
export const existsSync = () => false;
export const readFileSync = () => {
  throw new Error("File system is not available in browser mode. Use loadFromBuffer().");
};

export default {
  existsSync,
  readFileSync
};
