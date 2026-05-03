# Migration notes

## add_film_search_vector

Adds Postgres full-text search to the Film model.

- Extension: `pg_trgm`
- Column: `Film.searchVector` (`tsvector`, NULL allowed for legacy rows)
- Index: GIN on `searchVector`
- Trigger: `film_search_vector_trigger` keeps the column in sync with
  `title` (weight A), `director` (weight B), and `synopsis` (weight C).

The trigger is defined in raw SQL inside the migration. Prisma's schema
does not track triggers. If a future migration recreates the `Film`
table (rare), the trigger must be re-applied manually. Search quality
will silently degrade if this trigger is missing; new films will have
NULL `searchVector` and never appear in search results.

To verify the trigger is active:

```sql
SELECT tgname FROM pg_trigger WHERE tgrelid = '"Film"'::regclass;
```

Should include `film_search_vector_trigger`.
