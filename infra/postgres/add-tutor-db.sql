-- Adds tutor-service's role and database to a data volume created before it existed
-- (init.sql only runs on an empty volume). Safe to run more than once:
--   docker compose exec -T postgres psql -U tms -d postgres < infra/postgres/add-tutor-db.sql
SELECT 'CREATE ROLE tutor LOGIN CREATEDB PASSWORD ''tutor'''
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tutor') \gexec
SELECT 'CREATE DATABASE tutor_db OWNER tutor'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tutor_db') \gexec
REVOKE CONNECT ON DATABASE tutor_db FROM PUBLIC;
