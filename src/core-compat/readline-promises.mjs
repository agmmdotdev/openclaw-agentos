import readline from 'node:readline';
export const createInterface = (...args) => {
  if (!readline.promises?.createInterface) throw new Error('Promise readline is unavailable in this core profile');
  return readline.promises.createInterface(...args);
};
export const Readline = readline.promises?.Readline;
export default { createInterface, Readline };
