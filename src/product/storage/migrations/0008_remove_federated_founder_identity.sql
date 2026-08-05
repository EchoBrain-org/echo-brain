-- The product-local founder federation that wrote these tables is retired and
-- deleted; no code reads or writes them. Filesystem founder residue stays
-- preservation-only and fenced, but these empty-by-construction relational
-- shells leave with the capability, following the 0004 removal convention.
DROP TABLE IF EXISTS federated_source_attributions;
DROP TABLE IF EXISTS federated_processor_attributions;
DROP TABLE IF EXISTS federated_chain_heads;
DROP TABLE IF EXISTS federated_outbox_events;
