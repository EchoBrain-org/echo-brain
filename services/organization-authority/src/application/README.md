# Application

Commands, queries, and capability-shaped ports belong here. Each use case will
own one transaction-sized workflow; it will not expose table-level CRUD as the
domain API. Application code may use domain rules and ports but never concrete
adapters.
