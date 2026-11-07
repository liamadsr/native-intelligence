-- read-only: exported tables without a primary key (the export would have to page by ctid)
SELECT e.table_name
FROM public._wsmerge_export_tables() e
WHERE to_regclass('public.' || quote_ident(e.table_name)) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = ('public.' || quote_ident(e.table_name))::regclass AND i.indisprimary)
ORDER BY 1;
