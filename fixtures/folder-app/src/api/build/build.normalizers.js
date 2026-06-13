export function normalizeBuildImport(row) {
  return {
    name: row.name,
    public: row.public === true
  };
}
