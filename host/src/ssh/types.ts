export type SshCredential = {
  /** upstream ssh username */
  username?: string;
  /** private key in OpenSSH/PEM format */
  privateKey: string | Buffer;
  /** private key passphrase */
  passphrase?: string | Buffer;
};
