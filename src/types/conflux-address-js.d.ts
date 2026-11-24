declare module '@conflux-dev/conflux-address-js' {
  const cfxAddress: { decode(address: string): {
    hexAddress: Uint8Array;
    netId: number;
    type: 'user' | 'contract' | 'builtin' | 'null' | 'unknown';
  } };
  export default cfxAddress;
}
