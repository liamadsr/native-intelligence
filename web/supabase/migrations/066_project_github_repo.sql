-- Link projects to GitHub repositories
alter table projects add column if not exists github_repo text;

comment on column projects.github_repo is 'GitHub repo full name, e.g. "acme/myapp"';
