export async function up(db) {
  await db.schema.createTable('projects', table => {
    table.string('id').primary();
    table.string('owner_id').notNullable();
    table.string('slug').notNullable().unique();
    table.string('name').notNullable();
  });
}

export async function down(db) {
  await db.schema.dropTable('projects');
}
