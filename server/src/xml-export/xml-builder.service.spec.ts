import { createHash } from 'crypto';

import { AuditAction, AuditActorType, IssuanceStatus, Priority, UserRole, XmlOutboxStatus } from '../../../shared/@core';
import { XmlOutbox } from '../entities';
import { NAMESPACE, SCHEMA_VERSION, XmlBuildError, XmlBuilderService } from './xml-builder.service';

//the provisional document from a row and nothing else (docs/xml-export.md). the sha is of the bytes sent, a null value
//is an absent element, a corrupt payload is refused with the field's name

const ID = 'a0d17000-0000-4000-8000-00000000000a';

function row(over: Partial<XmlOutbox> = {}): XmlOutbox {
    return {
        id: ID,
        issuance_id: 12,
        sequence: 2,
        previous_status: IssuanceStatus.assigned,
        new_status: IssuanceStatus.delivered,
        trigger: AuditAction.delivery_report,
        payload: {
            issuance: { id: 12, sap_number: '7000001', number_prefix: "ס'", priority: Priority.normal, delivery_date: '2026-10-20', self_pickup: false, revision: 3 },
            actor: { type: AuditActorType.user, user_id: 4, username: 'c', role: UserRole.courier },
            details: { task_id: 9, attempt_id: 3, courier_id: 2, items_delivered: 2, items_total: 2, operation_id: null },
        },
        status: XmlOutboxStatus.processing,
        attempts: 1,
        next_retry_at: new Date('2026-10-14T08:00:00.000Z'),
        created_at: new Date('2026-10-14T08:00:00.000Z'),
        occurred_at: new Date('2026-10-14T08:00:00.000Z'),
        lease_until: null,
        processed_at: null,
        s3_key: null,
        content_sha256: null,
        last_error: null,
        ...over,
    };
}

const svc = new XmlBuilderService();

/*──────────────────────────────────────────────────────────────────────────*/

describe('XmlBuilderService.build', () => {
    it('renders the provisional document of the design notes, the sha256 of its utf-8 bytes next to it', () => {
        const { xml, sha256 } = svc.build(row());
        expect(xml).toBe(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                `<IssuanceStatusChange xmlns="${NAMESPACE}" schemaVersion="${SCHEMA_VERSION}">`,
                `  <EventId>${ID}</EventId>`,
                '  <Sequence>2</Sequence>',
                '  <OccurredAt>2026-10-14T08:00:00.000Z</OccurredAt>',
                '  <Issuance>',
                '    <Id>12</Id>',
                '    <SapNumber>7000001</SapNumber>',
                "    <NumberPrefix>ס&apos;</NumberPrefix>",
                '    <Priority>normal</Priority>',
                '    <DeliveryDate>2026-10-20</DeliveryDate>',
                '    <SelfPickup>false</SelfPickup>',
                '    <Revision>3</Revision>',
                '  </Issuance>',
                '  <PreviousStatus>assigned</PreviousStatus>',
                '  <NewStatus>delivered</NewStatus>',
                '  <Trigger>delivery.report</Trigger>',
                '  <Actor type="user">',
                '    <UserId>4</UserId>',
                '    <Username>c</Username>',
                '    <Role>courier</Role>',
                '  </Actor>',
                '  <Details>',
                '    <TaskId>9</TaskId>',
                '    <AttemptId>3</AttemptId>',
                '    <CourierId>2</CourierId>',
                '    <ItemsDelivered>2</ItemsDelivered>',
                '    <ItemsTotal>2</ItemsTotal>',
                '  </Details>',
                '</IssuanceStatusChange>',
                '',
            ].join('\n'),
        );
        expect(SCHEMA_VERSION).toBe('0.1-provisional');
        expect(sha256).toBe(createHash('sha256').update(xml, 'utf8').digest('hex'));
        expect(svc.build(row()).sha256).toBe(sha256); //the same row gives the same bytes, that is what a reclaimed row relies on
    });

    it('omits the elements whose value is null and takes occurred_at as a string too (a raw query row)', () => {
        const r = row({ occurred_at: '2026-10-14T08:00:00.000Z' as any });
        r.payload = { ...r.payload, issuance: { ...r.payload.issuance, number_prefix: null, delivery_date: null }, actor: { type: AuditActorType.system, user_id: null, username: null, role: null }, details: {} };
        const { xml } = svc.build(r);
        expect(xml).not.toContain('<NumberPrefix');
        expect(xml).not.toContain('<DeliveryDate');
        expect(xml).toContain('  <Actor type="system"/>');
        expect(xml).toContain('  <Details/>');
        expect(xml).toContain('<OccurredAt>2026-10-14T08:00:00.000Z</OccurredAt>');
    });

    it("never writes a customer field, a signature or a note, whatever a row's details hold", () => {
        const r = row();
        r.payload = { ...r.payload, details: { ...r.payload.details, customer_name: 'ישראל', customer_id_number: '012345678', customer_phone: '050', address_street: 'הרצל', address_city: 'תל אביב', signature_png: 'iVBOR', recipient_name: 'x', notes: 'n', reason: 'kept' } };
        const { xml } = svc.build(r);
        for (const leaked of ['ישראל', '012345678', '050', 'הרצל', 'תל אביב', 'iVBOR', 'Recipient', 'Notes', 'Customer', 'Address', 'Signature']) expect(xml).not.toContain(leaked);
        expect(xml).toContain('<Reason>kept</Reason>');
    });

    it('refuses a corrupt row with the name of what is wrong', () => {
        const bad = (over: Partial<XmlOutbox>, payload?: (p: any) => any) => {
            const r = row(over);
            if (payload) r.payload = payload(r.payload);
            return () => svc.build(r);
        };
        expect(bad({ sequence: 0 })).toThrow(new XmlBuildError('sequence is not a positive integer'));
        expect(bad({ previous_status: 'lost' as any })).toThrow('previous_status "lost" is not an issuance status');
        expect(bad({ new_status: null })).toThrow('new_status');
        expect(bad({ trigger: '' as any })).toThrow('trigger is missing');
        expect(bad({ occurred_at: 'yesterday' as any })).toThrow('occurred_at is not a date');
        expect(bad({ payload: null })).toThrow('payload is not an object');
        expect(bad({}, (p) => ({ ...p, issuance: undefined }))).toThrow('payload.issuance is missing');
        expect(bad({}, (p) => ({ ...p, issuance: { ...p.issuance, id: '12' } }))).toThrow('payload.issuance.id is not an integer');
        expect(bad({}, (p) => ({ ...p, issuance: { ...p.issuance, sap_number: '' } }))).toThrow('payload.issuance.sap_number is missing');
        expect(bad({}, (p) => ({ ...p, issuance: { ...p.issuance, revision: 1.5 } }))).toThrow('payload.issuance.revision is not an integer');
        expect(bad({}, (p) => ({ ...p, actor: { type: 'robot' } }))).toThrow('payload.actor.type is missing');
        expect(bad({}, (p) => ({ ...p, details: { task: { id: 1 } } }))).toThrow('payload.details.task is not a scalar');
        expect(bad({}, (p) => ({ ...p, details: { 'Task Id': 1 } }))).toThrow('payload.details.Task Id is not a detail name');
        expect(svc.build(row())).toBeTruthy(); //the fixture itself is fine
    });
});
