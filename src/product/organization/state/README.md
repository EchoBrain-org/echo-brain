# Organization state

The SQLite organization state store owns installation-local authority pin,
enrollment evidence, access-state sequence/hash, and trusted-clock
high-watermark invariants. Missing, corrupt, expired, rolled-back, or divergent
state fails closed; revoked state is terminal.
