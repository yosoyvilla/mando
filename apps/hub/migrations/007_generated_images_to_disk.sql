-- v1.5: move generated image bytes from Postgres bytea to disk files
-- (images/storage.ts, under MANDO_IMAGE_DIR). Existing bytea payloads
-- cannot become files as part of a migration, so this is a one-time,
-- accepted data loss for this fresh, not-yet-widely-used feature: delete
-- every existing row FIRST, then it's safe to add the two new NOT NULL
-- columns (there are no rows left for the NOT NULL check to fail on) and
-- drop the bytea column. migrate.ts runs this whole file as one atomic
-- simple-query string, so a mid-file failure rolls back everything above.
delete from generated_images;

alter table generated_images add column file_path text not null;
alter table generated_images add column size_bytes int not null;
alter table generated_images drop column bytes;
