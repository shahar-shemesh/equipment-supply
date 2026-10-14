import { BadRequestException } from '@nestjs/common';
import { IssuancesService } from './issuances.service';

describe('manager exact number lookup', () => {
  function setup() {
    const qb: any = {};
    for (const method of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'offset', 'limit']) qb[method] = jest.fn().mockReturnValue(qb);
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    //list() never writes, the audit service and the outbox are stubs
    return { qb, service: new IssuancesService(repo, null, null, { record: jest.fn() } as any, { record: jest.fn() } as any) };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  it('uses equality and preserves leading zeros', async () => {
    const { qb, service } = setup();
    await service.list({ number: '001234', page_size: 1 });
    expect(qb.andWhere).toHaveBeenCalledWith('i.sap_number = :number', { number: '001234' });
    expect(qb.where).toHaveBeenCalledWith('i.deleted_at IS NULL');
  });

  it.each(['', '12%', 'https://example.com/123', ['123'], { value: '123' }])('rejects malformed numbers: %s', async (number) => {
    const { service } = setup();
    await expect(service.list({ number })).rejects.toBeInstanceOf(BadRequestException);
  });
});
