import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv.parser.js';

describe('parseCsv', () => {
  it('skips the header and parses rows with ; delimiter', () => {
    const text = `data;descricao;valor
15/01/2024;Salario;2500.00
16/01/2024;Café;-12.50
`;
    const rows = parseCsv(text);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.description).toBe('Salario');
    expect(rows[0]?.amount).toBe(2500);
    expect(rows[0]?.type).toBe('INCOME');
    expect(rows[0]?.date.getFullYear()).toBe(2024);
    expect(rows[0]?.date.getMonth()).toBe(0);
    expect(rows[0]?.date.getDate()).toBe(15);
  });

  it('parses rows with , delimiter', () => {
    const text = `data,descricao,valor
2024-02-01,Freelance,800.00
`;
    const rows = parseCsv(text);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Freelance');
    expect(rows[0]?.amount).toBe(800);
    expect(rows[0]?.type).toBe('INCOME');
    expect(rows[0]?.date.getMonth()).toBe(1);
  });

  it('parses Brazilian amount 1.234,56 as negative (EXPENSE with positive amount)', () => {
    const text = `data;descricao;valor
10/03/2024;Aluguel;-1.234,56
`;
    const rows = parseCsv(text);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBeCloseTo(1234.56, 2);
    expect(rows[0]?.type).toBe('EXPENSE');
  });

  it('parses dd-MM-yyyy and dd/MM/yyyy HH:mm:ss dates', () => {
    const text = `data;descricao;valor
10-03-2024;Conta de luz;100.00
11/03/2024 14:30:00;Mercado;200.00
`;
    const rows = parseCsv(text);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.date.getDate()).toBe(10);
    expect(rows[0]?.date.getMonth()).toBe(2);
    expect(rows[1]?.date.getDate()).toBe(11);
    expect(rows[1]?.date.getHours()).toBe(14);
    expect(rows[1]?.date.getMinutes()).toBe(30);
  });

  it('ignores invalid lines without throwing', () => {
    const text = `data;descricao;valor
15/01/2024;Salario;2500.00
this line has no columns at all
99/99/9999;Data invalida;10.00
20/01/2024;Valor invalido;abc
;;;
`;
    expect(() => parseCsv(text)).not.toThrow();
    const rows = parseCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Salario');
  });
});
