-- read-only: columns of exported tables whose names suggest credential material
SELECT c.table_name, c.column_name, c.udt_name
FROM information_schema.columns c
JOIN public._wsmerge_export_tables() e ON e.table_name = c.table_name
WHERE c.table_schema = 'public'
  AND c.column_name ~* '(secret|token|password|passwd|api_key|apikey|credential|encrypted|private_key|signing|refresh|access_)'
ORDER BY 1, 2;
