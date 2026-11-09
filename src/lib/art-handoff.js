// Passa arquivos de uma aba para outra (ex.: Ampliar → Vetorizar) sem guardar nada em disco.
const pending = [];
export const sendFiles = files => { pending.push(...files); };
export const takeFiles = () => pending.splice(0);
