-- Adds audit-service's role and database to a data volume created before #54
-- (init.sql only runs on an empty volume). Safe to run more than once:
--   docker compose exec -T postgres psql -U tms -d postgres < infra/postgres/add-audit-db.sql
SELECT 'CREATE ROLE audit LOGIN CREATEDB PASSWORD ''audit'''
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit') \gexec
SELECT 'CREATE DATABASE audit_db OWNER audit'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'audit_db') \gexec
REVOKE CONNECT ON DATABASE audit_db FROM PUBLIC;
