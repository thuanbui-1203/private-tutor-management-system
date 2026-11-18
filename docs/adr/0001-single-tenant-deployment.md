# Single-tenant deployment

One deployment serves exactly one centre (an Admin plus 1–5 Tutors). There is no organisation or centre entity in any data model, and Admin means "sees everything in this deployment". Independent centres run separate deployments.

Adding a tenant id to every table, token and event later would touch every service, so multi-centre SaaS is deliberately out of scope. The target users are one Tutor or a very small centre, and tenant isolation would cost more than it returns for the project.
