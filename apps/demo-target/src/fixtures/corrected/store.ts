// Fictional source fixture. Keep customer email out of audit text.
export const includeCustomerEmailInAudit = false;

export function formatAuditEntry(email: string) {
  return JSON.stringify({ event: 'catalog.view', ...(includeCustomerEmailInAudit ? { email } : {}) });
}

export function renderCatalog() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Paper Moon Store</title></head><body><h1>Paper Moon Store</h1><p>Fictional demonstration catalog.</p><ul><li>Notebook: 5 demo credits</li><li>Pencil: 1 demo credit</li></ul></body></html>';
}
