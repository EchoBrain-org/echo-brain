# Presentation

`organization-authority-http-server.ts` owns bounded HTTP mechanics and route
dispatch for the Organization Authority API. Route-specific application
modules validate request shapes and call application/composition use cases.

Presentation does not open persistence, sign records, select providers, or own
process lifecycle. Optional provider ingress is mounted only through explicit
application interfaces and is rejected if it collides with an Authority route.
Authentication and authorization remain application responsibilities rather
than hidden UI or transport behavior.
