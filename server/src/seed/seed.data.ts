import { IssuanceStatus, Priority, UserRole } from '../../../shared/@core';

//sample data for the local foundation. names and addresses are the ones used in the figma screens where they existed.
//nothing here comes from SAP - the SAP interface is not defined, so this file is the only "source" of issuances for now

//courier = the couriers row below that carries this login. the first manager has one too: a manager holds the courier
//role (rolesOf in shared/auth.ts) and the mock manager identity opens the courier screens with tasks of their own
export const users = [
  { username: 'manager', display_name: 'דנה לוי', email: 'manager@equipment.local', role: UserRole.manager, courier: 'דנה לוי' },
  { username: 'manager2', display_name: 'אסף ברק', email: 'manager2@equipment.local', role: UserRole.manager },
  { username: 'courier1', display_name: 'יוסי אברהם', email: 'courier1@equipment.local', role: UserRole.courier, courier: 'יוסי אברהם' },
  { username: 'courier2', display_name: 'יעקב מזרחי', email: 'courier2@equipment.local', role: UserRole.courier, courier: 'יעקב מזרחי' },
  { username: 'courier3', display_name: 'מירי אבני', email: 'courier3@equipment.local', role: UserRole.courier, courier: 'מירי אבני' },
];

//id numbers are the ones printed on the ניהול שליחים screen, they do not pass the check digit (see courier.validation.ts)
export const couriers = [
  { name: 'יוסי אברהם', employee_id: 'E-1001', id_number: '300789909', phone: '052-1111111', zones: ['תל אביב', 'רמת גן'] },
  { name: 'יעקב מזרחי', employee_id: 'E-1002', id_number: '301289087', phone: '052-2222222', zones: ['פתח תקווה', 'ראש העין'] },
  { name: 'מירי אבני', employee_id: 'E-1003', id_number: '400789909', phone: '052-3333333', zones: ['חולון', 'בת ים'] },
  { name: 'אמנון שילוח בע"מ', employee_id: 'E-2001', id_number: '405980076', phone: '03-5555555', zones: ['ירושלים'] }, //external company, no login. ח.פ in the id column
  { name: 'דרום קווים', employee_id: 'E-2002', id_number: '301227367', phone: '08-6666666', zones: ['באר שבע'] }, //external company, no login
  { name: 'דנה לוי', employee_id: 'E-1000', id_number: '200789909', phone: '052-0000000', zones: ['תל אביב'] }, //the manager's own courier row, last so the indexes above keep their rows
];

//the couriers with a login, in the order of the users above: the handcrafted set spreads its tasks over them
const loginCouriers = users.filter((u) => u.courier).map((u) => u.courier);

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
    //only the couriers with a login get tasks, spread by n/3 so the same courier does not get every row
    const loginCourier = loginCouriers[Math.floor(n / 3) % loginCouriers.length];
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
      //n % 3 === 1 gave this row a courier above. self pickup means nobody drives it: no task, and no courier on the board
      status = IssuanceStatus.self_pickup;
      courier = null;
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

/*──────────────────────────────────────────────────────────────────────────*/

//mulberry32, a 32 bit prng small enough to live here. the generated rows below have to be the same on every run and
//every machine (the dates aside, they are relative to the seed day): the pagination spec compares api pages against
//sql on the seeded set, and a board that changes under the developer between two seeds is useless for "page 134 looked wrong"
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

//pools for the generated set. nothing here is from the design, the names are just common ones so the board reads as hebrew
const firstNames = ['אבי', 'אורי', 'איתי', 'אלון', 'אמיר', 'אסף', 'בועז', 'גיל', 'גלעד', 'דוד', 'דניאל', 'דרור', 'הדר', 'זיו', 'חן', 'טל', 'יאיר', 'יובל', 'יונתן', 'ינון', 'ירון', 'לירן', 'מאור', 'מתן', 'נדב', 'ניר', 'נעם', 'עומר', 'עידו', 'עמית', 'ערן', 'רועי', 'שי', 'תומר', 'נועה', 'שירה', 'מיכל', 'הילה', 'ליאת', 'מורן', 'ענת', 'תמר'];
const surnames = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'פרידמן', 'מלכה', 'אזולאי', 'דהן', 'חדד', 'גבאי', 'עמר', 'אוחיון', 'שפירא', 'ברק', 'סגל', 'רוזנברג', 'קליין', 'גולן', 'בן דוד', 'חיים', 'נחום', 'יוסף', 'שלום', 'ממן', 'אדרי', 'ברוך', 'זוהר', 'אלבז'];
const cities = ['תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'אשדוד', 'נתניה', 'באר שבע', 'בני ברק', 'חולון', 'רמת גן', 'אשקלון', 'רחובות', 'בת ים', 'הרצליה', 'כפר סבא', 'חדרה', 'מודיעין', 'לוד', 'רמלה', 'רעננה', 'הוד השרון', 'קריית גת', 'אילת', 'נצרת'];
const streets = ['הרצל', "ז'בוטינסקי", 'ויצמן', 'בן גוריון', 'רוטשילד', 'אלנבי', 'דיזנגוף', 'אבן גבירול', 'סוקולוב', 'ביאליק', 'אחד העם', 'הנשיא', 'הרב קוק', 'הפלמ"ח', 'ההגנה', 'בר אילן', 'ירושלים', 'יפו', 'הגליל', 'הנגב', 'הכרמל', 'השרון', 'הירדן', 'הארבעה', 'המלאכה', 'התעשייה', 'היצירה', 'המסגר', 'העצמאות', 'הבנים', 'השלום', 'המייסדים', 'ארלוזורוב', 'קפלן', 'בגין', 'רבין', 'שז"ר', 'ברנר', 'טשרניחובסקי', 'נורדאו'];
const buildings = ['קומה 1', 'קומה 2', 'קומה 3', 'קומה 4', "בניין א'", "בניין ב'", 'מחסן', 'אגף צפוני', 'אגף דרומי', 'חדר 12', 'כניסה ב'];
const bulkProducts = [
  { product_name: 'מחשב נייד', catalog_number: 'LPT-1001', station_prefix: '11' },
  { product_name: 'מחשב נייח', catalog_number: 'PKG-1102', station_prefix: '11' },
  { product_name: 'מסך 27', catalog_number: 'MON-2710', station_prefix: '12' },
  { product_name: 'מסך 24', catalog_number: 'MON-2410', station_prefix: '12' },
  { product_name: 'מקלדת', catalog_number: 'PKG-2244', station_prefix: '46' },
  { product_name: 'עכבר', catalog_number: 'PKG-2245', station_prefix: '46' },
  { product_name: 'מדפסת', catalog_number: 'PRN-3300', station_prefix: '27' },
  { product_name: 'סורק', catalog_number: 'SCN-3310', station_prefix: '27' },
  { product_name: 'שרת', catalog_number: 'SRV-1001', station_prefix: '33' },
  { product_name: 'מתג רשת', catalog_number: 'NET-4010', station_prefix: '34' },
  { product_name: 'נתב', catalog_number: 'NET-4020', station_prefix: '34' },
  { product_name: 'טלפון IP', catalog_number: 'TEL-5001', station_prefix: '51' },
  { product_name: 'מצלמת רשת', catalog_number: 'CAM-5100', station_prefix: '51' },
  { product_name: 'תחנת עגינה', catalog_number: 'DCK-1200', station_prefix: '11' },
  { product_name: 'כונן גיבוי', catalog_number: 'BKP-6001', station_prefix: '33' },
];
const phonePrefixes = ['050', '052', '053', '054', '055', '058', '02', '03', '04', '08', '09'];
const notePool = ['להתקשר לפני ההגעה', 'הכניסה מהחניון', 'למסור לשומר בכניסה', 'לא לפני 10:00', 'קומה ללא מעלית', 'איש קשר בשטח: מזכירות'];
const deleteReasons = ['בוטל על ידי הלקוח', 'הונפק בטעות', 'כפילות של הנפקה אחרת', 'הציוד הוחזר למחסן'];

//roughly the mix of a real week: most rows closed, a quarter waiting for a courier, a few deleted so the board has
//something to hide. percent, summing to 100
const statusWeights: [IssuanceStatus, number][] = [
  [IssuanceStatus.unassigned, 25],
  [IssuanceStatus.assigned, 15],
  [IssuanceStatus.delivered, 42],
  [IssuanceStatus.partially_delivered, 5],
  [IssuanceStatus.not_delivered, 5],
  [IssuanceStatus.self_pickup, 5],
  [IssuanceStatus.deleted, 3],
];

const closedStatuses = [IssuanceStatus.delivered, IssuanceStatus.partially_delivered, IssuanceStatus.not_delivered];

/*──────────────────────────────────────────────────────────────────────────*/

//count generated issuances on top of the 30 above, so the board has enough pages to break offset paging if it is broken.
//the customer is drawn first and keeps the address of their office, a repeat is the same place getting another box,
//which is what the courier board groups. the rows have the shape of buildIssuances() and go through the same loop
//in seed.service, so the task / attempt rules per status exist once
export function buildBulkIssuances(count: number) {
  const rows: any[] = [];
  const rand = mulberry32(20261007);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const today = new Date();
  const dateAt = (days: number) => {
    const d = new Date(today);
    d.setDate(today.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  //150 offices, each with the address it always receives at. drawn before the rows so a different count still gives the same pool
  const customerPool = [];
  for (let i = 0; i < 150; i++) {
    customerPool.push({
      name: `${pick(firstNames)} ${pick(surnames)}`,
      id_number: String(int(100000000, 399999999)), //9 digits, not checked against the check digit, same as the couriers above
      phone: `${pick(phonePrefixes)}-${int(1000000, 9999999)}`,
      street: `${pick(streets)} ${int(1, 120)}`,
      building: rand() < 0.7 ? pick(buildings) : null,
      city: pick(cities),
    });
  }

  for (let n = 0; n < count; n++) {
    const customer = pick(customerPool);

    let status = IssuanceStatus.unassigned;
    let roll = rand() * 100;
    for (const [s, weight] of statusWeights) {
      if (roll < weight) {
        status = s;
        break;
      }
      roll -= weight;
    }
    const closed = closedStatuses.includes(status);

    //a partial delivery needs a second line to leave behind, the seed loop delivers the first line and refuses the rest
    const itemCount = status === IssuanceStatus.partially_delivered ? int(2, 4) : int(1, 4);
    const items = [];
    for (let k = 0; k < itemCount; k++) {
      const p = pick(bulkProducts);
      items.push({
        line_no: k + 1,
        product_name: p.product_name,
        catalog_number: p.catalog_number,
        station_number: `#${p.station_prefix}${int(10, 99)}`,
        serial_number: `SN-${int(100000, 999999)}`,
        quantity: int(1, 3),
      });
    }

    const row: any = {
      //13 wide blocks from 2000000: not a plain sequence, never two the same, never inside the 1234567..1234944 range of the rows above
      sap_number: String(2000000 + n * 13 + int(0, 12)),
      number_prefix: rand() < 0.15 ? null : pick(["ס'", "ד'", "כ'"]),
      status,
      priority: rand() < 0.15 ? Priority.urgent : Priority.normal,
      customer_name: customer.name,
      customer_id_number: customer.id_number,
      customer_phone: customer.phone,
      address_street: customer.street,
      address_building: customer.building,
      address_city: customer.city,
      //a closed row was delivered (or not) on a past date, the others spread two months back and one month ahead
      delivery_date: rand() < 0.05 ? null : dateAt(closed ? int(-60, -1) : int(-60, 30)),
      self_pickup: status === IssuanceStatus.self_pickup,
      notes: rand() < 0.1 ? pick(notePool) : null,
      source: 'sample',
      items,
      //any of the couriers, the two companies included, only where the seed loop has a task to create
      courier: closed || status === IssuanceStatus.assigned ? pick(couriers).name : null,
    };

    //the shape softDelete in issuances.service leaves behind: status deleted, when and why, no task.
    //the hour is drawn too, so two calls on the same day build the same Date and the determinism spec can compare them
    if (status === IssuanceStatus.deleted) {
      const deletedAt = new Date(today);
      deletedAt.setDate(today.getDate() - int(0, 30));
      deletedAt.setHours(int(8, 17), int(0, 59), 0, 0);
      row.deleted_at = deletedAt;
      row.delete_reason = pick(deleteReasons);
    }

    rows.push(row);
  }

  return rows;
}

//a real png (1x1 transparent). the seeded attempts need something in signature_png, the canvas will write real ones
export const SAMPLE_SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
