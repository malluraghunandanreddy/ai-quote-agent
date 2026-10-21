import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { applyPlan, buildTemplate, customerBody, itemBody, parseOnboarding, parsePrice, planOnboarding, type Plan } from '../src/ops/onboard';

const filled = async (company: string[][], items: Array<Array<string | number>>, extra: { skipCompany?: boolean; skipItems?: boolean } = {}): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  if (!extra.skipCompany) {
    const c = wb.addWorksheet('Company');
    c.addRow(['Company name', 'Contact person', 'Email', 'City']);
    for (const r of company) c.addRow(r);
  }
  if (!extra.skipItems) {
    const i = wb.addWorksheet('Items');
    i.addRow(['Item name', 'Item code', 'Unit', 'Selling price', 'Description']);
    for (const r of items) i.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
};

describe('price text', () => {
  it('reads ordinary ways of writing a rupee price, and nothing else', () => {
    assert.equal(parsePrice('1250'), 1250);
    assert.equal(parsePrice('₹1,250.50'), 1250.5);
    assert.equal(parsePrice('Rs. 99'), 99);
    assert.equal(parsePrice('INR 1 200'), 1200);
    assert.ok(Number.isNaN(parsePrice('about 100')));
    assert.ok(Number.isNaN(parsePrice('')));
    assert.ok(Number.isNaN(parsePrice('-5')));
  });
});

describe('reading the client form', () => {
  it('the blank form has only grey examples, which are ignored, so it asks for real answers', async () => {
    const r = await parseOnboarding(await buildTemplate());
    assert.deepEqual([r.companies.length, r.items.length], [0, 0]);
    assert.ok(r.problems.some((p) => /No company/.test(p)));
    assert.ok(r.problems.some((p) => /No items/.test(p)));
  });

  it('reads a filled form: the company, and each item with its code, unit and price', async () => {
    const r = await parseOnboarding(await filled([['  Sri   Lakshmi Traders Pvt Ltd ', 'Ravi Kumar', 'ravi@srilakshmi.example', 'Guntur']], [['Hex bolt M12 x 60 SS304', 'HB-1260', 'pcs', '₹12.50', ''], ['Relay 7A', '', '', 450, 'Aux relay'], ['Example: ignore me', '', '', 1, '']]));
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.companies, [{ name: 'Sri Lakshmi Traders Pvt Ltd', contact: 'Ravi Kumar', email: 'ravi@srilakshmi.example', city: 'Guntur' }]);
    assert.deepEqual(r.items, [
      { name: 'Hex bolt M12 x 60 SS304', code: 'HB-1260', unit: 'pcs', price: 12.5, description: '' },
      { name: 'Relay 7A', code: '', unit: 'pcs', price: 450, description: 'Aux relay' },
    ]);
  });

  it('says in plain words what is wrong, item by item', async () => {
    const r = await parseOnboarding(await filled([['Acme', '', 'not-an-email', '']], [['Bolt', '', 'pcs', ''], ['Nut', '', 'pcs', 'cheap'], ['Washer', '', 'pcs', 10], ['washer ', '', 'pcs', 12]]));
    const text = r.problems.join('\n');
    assert.match(text, /"not-an-email" is not a valid email/);
    assert.match(text, /"Bolt": the selling price is missing/);
    assert.match(text, /"Nut": "cheap" is not a price/);
    assert.match(text, /"washer": listed twice/);
  });

  it('reports a missing sheet instead of crashing', async () => {
    assert.ok((await parseOnboarding(await filled([], [], { skipItems: true }))).problems.some((p) => /sheet "Items" is missing/.test(p)));
    assert.ok((await parseOnboarding(await filled([], [], { skipCompany: true }))).problems.some((p) => /sheet "Company" is missing/.test(p)));
  });
});

describe('what would change', () => {
  const input = { companies: [{ name: 'Acme Industries Pvt Ltd', contact: '', email: 'buy@acme.example', city: '' }], items: [{ name: 'Relay 7A', code: 'R-7', unit: 'pcs', price: 450, description: '' }, { name: 'Bolt', code: '', unit: 'pcs', price: 5, description: '' }], problems: [] };

  it('creates what is missing', () => {
    const plan = planOnboarding(input, { contacts: [], items: [] });
    assert.deepEqual([plan.createCompanies.length, plan.createItems.length, plan.skipped.length], [1, 2, 0]);
  });

  it('skips what is already there: by name, by email, by code, and ignoring a leftover "SAMPLE - " prefix', () => {
    const plan = planOnboarding(input, { contacts: [{ contact_name: 'ACME  Industries Pvt Ltd' }], items: [{ name: 'SAMPLE - Bolt', sku: '' }, { name: 'Something else', sku: 'r-7' }] });
    assert.deepEqual([plan.createCompanies.length, plan.createItems.length, plan.skipped.length], [0, 0, 3]);
    assert.equal(planOnboarding(input, { contacts: [{ contact_name: 'Other Ltd', email: 'BUY@acme.example' }], items: [] }).createCompanies.length, 0, 'same email counts as the same customer');
  });
});

describe('creating it in Zoho Books', () => {
  const plan: Plan = {
    createCompanies: [{ name: 'Acme', contact: 'Ravi', email: 'r@acme.example', city: 'Guntur' }],
    createItems: [{ name: 'Relay 7A', code: 'R-7', unit: 'pcs', price: 450, description: '' }, { name: 'Bolt', code: '', unit: 'nos', price: 5, description: 'M12' }],
    skipped: [],
  };

  it('sends the customer and the items in the shape Zoho expects', () => {
    assert.deepEqual(customerBody(plan.createCompanies[0]!), { contact_name: 'Acme', company_name: 'Acme', contact_type: 'customer', customer_sub_type: 'business', billing_address: { city: 'Guntur', country: 'India' }, contact_persons: [{ first_name: 'Ravi', email: 'r@acme.example', is_primary_contact: true }] });
    assert.deepEqual(itemBody(plan.createItems[0]!), { name: 'Relay 7A', sku: 'R-7', rate: 450, unit: 'pcs', product_type: 'goods', item_type: 'sales' });
    assert.equal(itemBody(plan.createItems[1]!).description, 'M12');
    assert.equal('sku' in itemBody(plan.createItems[1]!), false);
  });

  it('creates each one, carries on after a failure, and explains a GST problem', async () => {
    const calls: Array<[string, unknown]> = [];
    const post = async (path: string, body: unknown): Promise<never> => {
      calls.push([path, body]);
      if (path === '/contacts') throw new Error('Place of contact is required for GST customers');
      if ((body as { name: string }).name === 'Relay 7A') throw new Error('Item already exists');
      return {} as never;
    };
    const lines: string[] = [];
    const r = await applyPlan({ post }, plan, (l) => lines.push(l));
    assert.deepEqual(r, { created: 1, failed: 2 });
    assert.deepEqual(calls.map(([p]) => p), ['/contacts', '/items', '/items'], 'it kept going after the first failure');
    assert.match(lines.join('\n'), /uses GST: add this customer by hand/);
    assert.match(lines.join('\n'), /created item Bolt/);
  });

  it('does nothing when there is nothing to create', async () => {
    let called = 0;
    assert.deepEqual(await applyPlan({ post: async () => void called++ as never }, { createCompanies: [], createItems: [], skipped: [] }), { created: 0, failed: 0 });
    assert.equal(called, 0);
  });
});
