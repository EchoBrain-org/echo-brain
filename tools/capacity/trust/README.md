The public FreeTSA root certificate was downloaded from
[FreeTSA's published root](https://freetsa.org/files/cacert.pem).
It is a public trust anchor, not a private key or application credential.

The timestamp client pins the raw PEM SHA-256 in registry.mjs and verifies both
the RFC 3161 message imprint and request nonce with OpenSSL. An edited local
receipt, a self-signed replacement root, or a response for another commitment
cannot substitute for the third-party signature. The verifier image must pin
this client and trust-root digest independently of the candidate. Root rotation
requires review and a new verifier environment lock.

Only commitment hashes are sent to the timestamp authority. The private trace,
fixture outputs and random seed remain on the verifier host until reveal.

Protocol references: [FreeTSA](https://freetsa.org/index_en.php),
[OpenSSL timestamp verification](https://docs.openssl.org/3.6/man1/openssl-ts/).
