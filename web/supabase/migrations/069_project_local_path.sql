-- Store the local filesystem path to the project's repository
alter table projects add column if not exists local_path text;

comment on column projects.local_path is 'Local filesystem path to the project repo, e.g. "/Users/liam/code/myapp"';
