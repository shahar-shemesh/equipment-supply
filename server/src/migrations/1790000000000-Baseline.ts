import { MigrationInterface, QueryRunner } from 'typeorm';

//FROZEN. never edit this file, not even to follow an entity change: write a new migration instead. every database that
//recorded it either holds the schema it built or had its tables before it and skipped it, so an edit would only reach
//the next empty database and the two would drift apart. src/baseline-migration.spec.ts pins its sha-256.
//
//the schema of 2026-10-26 for an empty database. the first deployment ran synchronize, so the base tables never had a
//migration of their own and migration:run on an empty database stopped at the first one (relation "issuances" does not
//exist). the statements below are the schema builder's own sql on an empty database (ds.driver.createSchemaBuilder().log()
//with the entities of that day), in its order, names and types untouched. the ten migrations after this one are guarded,
//so on the schema it builds they replay as no-ops.
//
//all or nothing, decided by which of the twelve tables of the entities exist in current_schema() (pg_class, so a view of
//the same name does not count and the migration role's privileges on a table do not hide it):
//- none of them: an empty database, everything below is created
//- any of the seven base tables: an existing database, of whatever version. nothing runs but the check, the later
//  migrations bring it up as they always did. any and not all: this file cannot follow a later migration that renames
//  or drops a base table, and the databases built after that one must still read as existing. a database missing base
//  tables fails in the first migration that needs one, as it did before this file. no IF NOT EXISTS per statement on
//  purpose: on an older database they would add today's indexes and constraints ahead of the migrations that own them
//- only tables of the later migrations: refused with their names, nothing is created
//typeorm 0.3 runs a pending migration older than the last applied one (the timestamp check in MigrationExecutor is
//commented out), so a database that recorded the ten already records this one on its next migration:run

//the tables the ten later migrations assume and never create (OfflineSync1790600000000 alters issuances first)
const BASE_TABLES = ['users', 'couriers', 'issuances', 'issuance_items', 'delivery_tasks', 'delivery_attempts', 'delivery_attempt_items'];
//created by those migrations. here only so a database holding nothing but these is told apart from an empty one
const LATER_TABLES = ['delivery_operations', 'delivery_conflicts', 'audit_log', 'xml_outbox', 'xml_import_files'];

const SCHEMA = [
  `CREATE TABLE "users" ("id" SERIAL NOT NULL, "username" character varying NOT NULL, "display_name" character varying NOT NULL, "email" character varying, "role" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE ("username"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
  `CREATE TABLE "issuance_items" ("id" SERIAL NOT NULL, "issuance_id" integer NOT NULL, "line_no" integer NOT NULL, "product_name" character varying NOT NULL, "catalog_number" character varying, "station_number" character varying, "serial_number" character varying, "quantity" integer NOT NULL DEFAULT '1', "removed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_8f5554b2c250669e4f2d40494f2" PRIMARY KEY ("id"))`,
  `CREATE TABLE "issuances" ("id" SERIAL NOT NULL, "sap_number" character varying NOT NULL, "number_prefix" character varying, "status" character varying NOT NULL DEFAULT 'unassigned', "priority" character varying NOT NULL DEFAULT 'normal', "customer_name" character varying NOT NULL, "customer_id_number" character varying, "customer_phone" character varying, "address_street" character varying NOT NULL, "address_building" character varying, "address_city" character varying NOT NULL, "delivery_date" date, "self_pickup" boolean NOT NULL DEFAULT false, "notes" character varying, "source" character varying NOT NULL DEFAULT 'sample', "revision" integer NOT NULL DEFAULT '1', "delivered_by_user_id" integer, "deleted_at" TIMESTAMP WITH TIME ZONE, "delete_reason" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_b4ed052f24f1ea2744d0015366c" UNIQUE ("sap_number"), CONSTRAINT "PK_6f8e39378d7db5751ebec94a605" PRIMARY KEY ("id"))`,
  `CREATE TABLE "delivery_attempt_items" ("id" SERIAL NOT NULL, "attempt_id" integer NOT NULL, "item_id" integer NOT NULL, "delivered" boolean NOT NULL, "reason" character varying, "reason_details" character varying, CONSTRAINT "PK_b441ffaf615d88a7f9ac4abe167" PRIMARY KEY ("id"))`,
  `CREATE TABLE "delivery_attempts" ("id" SERIAL NOT NULL, "task_id" integer NOT NULL, "outcome" character varying NOT NULL, "recipient_type" character varying, "recipient_name" character varying, "recipient_id_number" character varying, "recipient_phone" character varying, "signature_png" text, "reported_at" TIMESTAMP NOT NULL DEFAULT now(), "client_reported_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_41eba4eb5401d72860f7cd9a7ac" PRIMARY KEY ("id"))`,
  `CREATE TABLE "delivery_tasks" ("id" SERIAL NOT NULL, "issuance_id" integer NOT NULL, "courier_id" integer, "status" character varying NOT NULL DEFAULT 'pending', "scheduled_date" date, "assigned_by" integer, "assigned_at" TIMESTAMP NOT NULL DEFAULT now(), "closed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_134fab28ea0e1fb1e666de786bf" PRIMARY KEY ("id"))`,
  `CREATE TABLE "couriers" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "employee_id" character varying, "id_number" character varying, "phone" character varying, "email" character varying, "zones" text, "active" boolean NOT NULL DEFAULT true, "user_id" integer, CONSTRAINT "UQ_6dfad0432c55d6f7a8269d29ee3" UNIQUE ("id_number"), CONSTRAINT "UQ_e3f889b75b7c9f89ab5a1242f8d" UNIQUE ("user_id"), CONSTRAINT "PK_141c3ed6f70beb9ddf4ab4a0e86" PRIMARY KEY ("id"))`,
  `CREATE TABLE "delivery_operations" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "courier_id" integer NOT NULL, "operation_id" character varying(64) NOT NULL, "task_id" integer NOT NULL, "attempt_id" integer NOT NULL, "payload_hash" character varying(64) NOT NULL, "client_reported_at" TIMESTAMP WITH TIME ZONE, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "result" jsonb NOT NULL, CONSTRAINT "PK_eec63c5360cfb1612c61bc97aa3" PRIMARY KEY ("id"))`,
  `CREATE UNIQUE INDEX "UQ_delivery_operations_user_operation" ON "delivery_operations" ("user_id", "operation_id") `,
  `CREATE TABLE "delivery_conflicts" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "courier_id" integer NOT NULL, "operation_id" character varying(64) NOT NULL, "task_id" integer NOT NULL, "issuance_id" integer NOT NULL, "submitted_revision" integer, "recipient_type" character varying, "recipient_name" character varying, "recipient_id_number" character varying, "recipient_phone" character varying, "items" jsonb NOT NULL, "signature_png" text, "payload_hash" character varying(64) NOT NULL, "rejection_code" character varying NOT NULL, "rejection_message" text, "observed" jsonb NOT NULL, "client_reported_at" TIMESTAMP WITH TIME ZONE, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "review_status" character varying NOT NULL DEFAULT 'pending', "reviewed_by" integer, "reviewed_at" TIMESTAMP WITH TIME ZONE, "review_note" text, "review_version" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_1ef3672e9b3fe4e4d3ff9438ad7" PRIMARY KEY ("id"))`,
  `CREATE UNIQUE INDEX "UQ_delivery_conflicts_user_operation" ON "delivery_conflicts" ("user_id", "operation_id") `,
  `CREATE TABLE "audit_log" ("id" SERIAL NOT NULL, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "actor_type" character varying(8) NOT NULL, "actor_user_id" integer, "actor_username" character varying, "actor_role" character varying, "action" character varying(40) NOT NULL, "entity_type" character varying(24) NOT NULL, "entity_id" integer, "issuance_id" integer, "batch_id" character varying(36), "details" jsonb, CONSTRAINT "PK_07fefa57f7f5ab8fc3f52b3ed0b" PRIMARY KEY ("id"))`,
  `CREATE INDEX "IDX_ba27cef5b8b2b1a756e06ebcc5" ON "audit_log" ("at") `,
  `CREATE INDEX "IDX_c90b869e72230a796448270652" ON "audit_log" ("entity_type", "entity_id", "at") `,
  `CREATE INDEX "IDX_8ada4f72e42ec0f798a0df2d7f" ON "audit_log" ("actor_user_id", "at") `,
  `CREATE INDEX "IDX_dc621dc4ab65d17b17ad152be4" ON "audit_log" ("issuance_id", "at") `,
  `CREATE TABLE "xml_outbox" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "issuance_id" integer NOT NULL, "sequence" integer NOT NULL, "previous_status" character varying(24) NOT NULL, "new_status" character varying(24) NOT NULL, "trigger" character varying(40) NOT NULL, "payload" jsonb NOT NULL, "status" character varying(12) NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "next_retry_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "lease_until" TIMESTAMP WITH TIME ZONE, "processed_at" TIMESTAMP WITH TIME ZONE, "s3_key" character varying, "content_sha256" character(64), "last_error" text, CONSTRAINT "PK_85b4b0a51fec6c5acffc0ac4207" PRIMARY KEY ("id"))`,
  `CREATE INDEX "IDX_747c9801082ff5e8f5ce3a491c" ON "xml_outbox" ("status", "lease_until") `,
  `CREATE UNIQUE INDEX "IDX_aec6f50be0779d8a8a4c130d91" ON "xml_outbox" ("issuance_id", "sequence") `,
  `CREATE INDEX "IDX_f859a1c70488d1d0bd13a3643f" ON "xml_outbox" ("status", "next_retry_at") `,
  `CREATE TABLE "xml_import_files" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "content_sha256" character(64) NOT NULL, "document_id" character varying(100), "file_name" character varying NOT NULL, "size_bytes" integer NOT NULL, "status" character varying(12) NOT NULL, "error_kind" character varying(12), "attempts" integer NOT NULL DEFAULT '0', "instance_id" character varying(64), "lease_until" TIMESTAMP WITH TIME ZONE, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "inserted" integer NOT NULL DEFAULT '0', "updated" integer NOT NULL DEFAULT '0', "unchanged" integer NOT NULL DEFAULT '0', "last_error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_7f8bb05760f345aa54d6f7440fd" UNIQUE ("content_sha256"), CONSTRAINT "UQ_279225ea8a62a8da2551a766097" UNIQUE ("document_id"), CONSTRAINT "PK_e17e2ca4afe1d6e25f435f94565" PRIMARY KEY ("id"))`,
  `ALTER TABLE "issuance_items" ADD CONSTRAINT "FK_9eb617a023e52044c0e950a7f17" FOREIGN KEY ("issuance_id") REFERENCES "issuances"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
  `ALTER TABLE "delivery_attempt_items" ADD CONSTRAINT "FK_0f9ebd4dbb1913d3eea0f215c79" FOREIGN KEY ("attempt_id") REFERENCES "delivery_attempts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
  `ALTER TABLE "delivery_attempts" ADD CONSTRAINT "FK_2971ecc7fb01190915a175e4b4f" FOREIGN KEY ("task_id") REFERENCES "delivery_tasks"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
  `ALTER TABLE "delivery_tasks" ADD CONSTRAINT "FK_2b99966b0aaa3b47674b6d8ebba" FOREIGN KEY ("issuance_id") REFERENCES "issuances"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
  `ALTER TABLE "delivery_tasks" ADD CONSTRAINT "FK_fb9c65efbca02d766e3b272e462" FOREIGN KEY ("courier_id") REFERENCES "couriers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
  `ALTER TABLE "delivery_operations" ADD CONSTRAINT "FK_ec298294ee28fdd0ebb31b4bb87" FOREIGN KEY ("attempt_id") REFERENCES "delivery_attempts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
  `ALTER TABLE "delivery_conflicts" ADD CONSTRAINT "FK_55bad82956240be7ed3a43e078d" FOREIGN KEY ("task_id") REFERENCES "delivery_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
];

export class Baseline1790000000000 implements MigrationInterface {
  name = 'Baseline1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: { name: string }[] = await queryRunner.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND c.relname::text = ANY($1::text[]) ORDER BY c.relname`, [[...BASE_TABLES, ...LATER_TABLES]]);
    const present = rows.map((r) => r.name);

    //an existing database: not a single statement, whatever its version. the later migrations take it from here
    if (present.some((t) => BASE_TABLES.includes(t))) return;

    //only what the later migrations create: building next to it would hide that the base tables are gone
    if (present.length) {
      throw new Error(`Baseline1790000000000: the database holds tables of the later migrations but none of the base tables, so it is neither empty nor an existing installation. present: ${present.join(', ')}; missing base tables: ${BASE_TABLES.join(', ')}. nothing was created, restore the base tables or start from an empty database`);
    }

    for (const sql of SCHEMA) await queryRunner.query(sql);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //migration:revert takes the row with the highest id. while other rows are still there, this one was recorded after
  //them, over a database that already existed: its up executed nothing, so there is nothing to take back and only the row
  //goes. alone in the table it is the first migration of a database it built, and taking that back would drop every table
  //with its data: refused
  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = queryRunner.connection.options.migrationsTableName || 'migrations';
    const others: { n: number }[] = await queryRunner.query(`SELECT count(*)::int AS n FROM "${table}" WHERE name <> $1`, [this.name]);
    if (others[0].n > 0) return;
    throw new Error('Baseline1790000000000 cannot be reverted on a database it built: its down would drop every table with the data. to start over, drop the database and run migration:run on the empty one');
  }
}
