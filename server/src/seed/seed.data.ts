import { IssuanceStatus, Priority, UserRole } from '../../../shared/@core';

//sample data for the local foundation. names and addresses are the ones used in the figma screens where they existed.
//nothing here comes from SAP - the SAP interface is not defined, so this file is the only "source" of issuances for now

export const users = [
  { username: 'manager', display_name: 'דנה לוי', role: UserRole.manager },
  { username: 'manager2', display_name: 'אסף ברק', role: UserRole.manager },
  { username: 'courier1', display_name: 'יוסי אברהם', role: UserRole.courier, courier: 'יוסי אברהם' },
  { username: 'courier2', display_name: 'יעקב מזרחי', role: UserRole.courier, courier: 'יעקב מזרחי' },
  { username: 'courier3', display_name: 'מירי אבני', role: UserRole.courier, courier: 'מירי אבני' },
];

//id numbers are the ones printed on the ניהול שליחים screen, they do not pass the check digit (see courier.validation.ts)
export const couriers = [
  { name: 'יוסי אברהם', employee_id: 'E-1001', id_number: '300789909', phone: '052-1111111', zones: ['תל אביב', 'רמת גן'] },
  { name: 'יעקב מזרחי', employee_id: 'E-1002', id_number: '301289087', phone: '052-2222222', zones: ['פתח תקווה', 'ראש העין'] },
  { name: 'מירי אבני', employee_id: 'E-1003', id_number: '400789909', phone: '052-3333333', zones: ['חולון', 'בת ים'] },
  { name: 'אמנון שילוח בע"מ', employee_id: 'E-2001', id_number: '405980076', phone: '03-5555555', zones: ['ירושלים'] }, //external company, no login. ח.פ in the id column
  { name: 'דרום קווים', employee_id: 'E-2002', id_number: '301227367', phone: '08-6666666', zones: ['באר שבע'] }, //external company, no login
];

const customers = [
  { name: 'עדי כהן-הלוי', id_number: '012345678', phone: '052-1234567' },
  { name: 'ישראל ישראלי', id_number: '023456789', phone: '050-1234567' },
  { name: 'יוסי כהן', id_number: '034567890', phone: '054-7654321' },
  { name: 'רונית שפירא', id_number: '045678901', phone: '053-9876543' },
  { name: 'משה דיין', id_number: '056789012', phone: '052-4455667' },
  { name: 'אורית אבני', id_number: '067890123', phone: '050-9988776' },
  { name: 'יעל מזרחי', id_number: '078901234', phone: '058-1122334' },
  { name: 'דני שגב', id_number: '089012345', phone: '052-6677889' },
  { name: 'נועה ברק', id_number: '090123456', phone: '054-3344556' },
  { name: 'אריאל פרץ', id_number: '101234567', phone: '050-2211334' },
];

const addresses = [
  { street: 'הלל 45', building: 'בניין B קומה 3, חדר 1', city: 'רמת גן' },
  { street: 'רחוב הרצל 10', building: 'היובל', city: 'תל אביב' },
  { street: 'דרך השלום 14', building: "בניין א'", city: 'תל אביב' },
  { street: 'הרצל 45', building: 'בניין מרכזי קומה 1', city: 'פתח תקווה' },
  { street: 'ז\'בוטינסקי 9', building: 'קומה 4', city: 'רמת גן' },
  { street: 'סוקולוב 3', building: 'דירה 12', city: 'חולון' },
  { street: 'ההסתדרות 88', building: 'מחסן', city: 'פתח תקווה' },
  { street: 'אחד העם 14', building: 'קומה 2', city: 'תל אביב' },
  { street: 'יפו 210', building: 'בניין הממשלה', city: 'ירושלים' },
  { street: 'רגר 5', building: 'קומה 6', city: 'באר שבע' },
];

const products = [
  { product_name: 'מחשב IEXXX', catalog_number: 'PKG-1102', station_prefix: '11' },
  { product_name: 'מקלדת', catalog_number: 'PKG-2244', station_prefix: '46' },
  { product_name: 'שרת', catalog_number: 'SRV-1001', station_prefix: '33' },
  { product_name: 'מסך 24', catalog_number: 'MON-2410', station_prefix: '12' },
  { product_name: 'מדפסת', catalog_number: 'PRN-3300', station_prefix: '27' },
];

/*──────────────────────────────────────────────────────────────────────────*/

//30 issuances built from the arrays above with a fixed pattern, so every seed run gives the same rows.
//status tells the seed service what to create around the issuance (task, attempt)
export function buildIssuances() {
  const rows: any[] = [];
  const today = new Date();

  for (let n = 0; n < 30; n++) {
    const customer = customers[n % customers.length];
    //two pairs share customer + address on purpose, the boards group those ("2 הנפקות")
    const address = addresses[n === 1 ? 0 : n === 12 ? 3 : n % addresses.length];
    const customerOfPair = n === 1 ? customers[0] : n === 12 ? customers[2] : customer;

    const date = new Date(today);
    date.setDate(today.getDate() + (n % 5) - 1);

    let status = IssuanceStatus.unassigned;
    let courier: string = null;
    //only the three couriers with a login get tasks, spread by n/3 so the same courier does not get every row
    const loginCourier = couriers[Math.floor(n / 3) % 3].name;
    if (n % 3 === 1) {
      status = IssuanceStatus.assigned;
      courier = loginCourier;
    }
    if (n % 5 === 4) {
      status = IssuanceStatus.delivered;
      courier = loginCourier;
    }
    if (n === 7) {
      status = IssuanceStatus.partially_delivered;
      courier = couriers[0].name;
    }
    if (n === 13) {
      status = IssuanceStatus.not_delivered;
      courier = couriers[0].name;
    }
    if (n === 22) {
      status = IssuanceStatus.self_pickup;
    }

    const itemCount = n % 4 === 0 ? 2 : n === 7 ? 3 : 1;
    const items = [];
    for (let k = 0; k < itemCount; k++) {
      const p = products[(n + k) % products.length];
      items.push({
        line_no: k + 1,
        product_name: p.product_name,
        catalog_number: p.catalog_number,
        station_number: `#${p.station_prefix}${(n * 7 + k) % 90 + 10}`,
        serial_number: `SN-${900000 + n * 137 + k * 11}`,
        quantity: 1,
      });
    }

    rows.push({
      sap_number: String(1234567 + n * 13),
      number_prefix: n % 3 === 0 ? "ס'" : n % 3 === 1 ? "ד'" : "כ'", //mirrors the design, the meaning is still unknown
      status,
      priority: n % 6 === 0 || n === 7 ? Priority.urgent : Priority.normal,
      customer_name: customerOfPair.name,
      customer_id_number: customerOfPair.id_number,
      customer_phone: customerOfPair.phone,
      address_street: address.street,
      address_building: address.building,
      address_city: address.city,
      delivery_date: date.toISOString().slice(0, 10),
      self_pickup: status === IssuanceStatus.self_pickup,
      source: 'sample',
      items,
      courier, //seed only, resolved to a task by seed.service
    });
  }

  return rows;
}

//a real png (1x1 transparent). the seeded attempts need something in signature_png, the canvas will write real ones
export const SAMPLE_SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
