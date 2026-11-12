import { describe, expect, it } from 'vitest';
import { PARSER_VERSION, parseCapture } from './index.js';
import { parseBrlAmount } from './amount.js';

// Fixtures keep the exact shape of the real notification texts; merchants, people, amounts and card endings are invented.
const NU = 'com.nu.production';
const MP = 'com.mercadopago.wallet';
const parse = (pkg: string, title: string | null, text: string) => parseCapture({ package: pkg, title, text });

describe('parseBrlAmount (Brazilian reais)', () => {
  it.each([
    ['9,90', 9.9],
    ['0,01', 0.01],
    ['200,00', 200],
    ['1.234,56', 1234.56],
    ['50.000,00', 50000],
    ['1.234.567,89', 1234567.89],
    ['15', 15],
  ])('reads %s as %d', (raw, expected) => {
    expect(parseBrlAmount(raw)).toBe(expected);
  });

  it.each(['', 'abc', '1,2,3', '1.23,4', '12,345', '-5,00', '1,234.56'])('refuses %j', (raw) => {
    expect(parseBrlAmount(raw)).toBeNull();
  });
});

describe('Nubank', () => {
  it('reads a credit card purchase as an expense, keeping the merchant as it came', () => {
    expect(parse(NU, 'Compra no crédito aprovada', 'Compra de R$ 37,50 APROVADA em EC     *LOJAFICTICIA para o cartão com final 1234.')).toEqual({
      kind: 'CARD_PURCHASE', type: 'EXPENSE', amount: 37.5, description: 'EC *LOJAFICTICIA', cardLast4: '1234',
    });
  });

  it('reads thousands and cents of a purchase', () => {
    const parsed = parse(NU, 'Compra no crédito aprovada', 'Compra de R$ 1.234,56 APROVADA em MERCADO TESTE para o cartão com final 9876.');
    expect(parsed).toMatchObject({ kind: 'CARD_PURCHASE', type: 'EXPENSE', amount: 1234.56, description: 'MERCADO TESTE' });
  });

  it('reads a NuPay credit payment, with its number of installments', () => {
    expect(parse(NU, 'Pagamento com NuPay aprovado', 'R$ 12,34 em 1x no crédito sem juros com NuPay APROVADO em Corrida App.')).toEqual({
      kind: 'CARD_PURCHASE', type: 'EXPENSE', amount: 12.34, description: 'Corrida App', installments: 1,
    });
    expect(parse(NU, 'Pagamento com NuPay aprovado', 'R$ 1.200,00 em 3x no crédito sem juros com NuPay APROVADO em Loja Online.')).toMatchObject({
      amount: 1200, installments: 3,
    });
  });

  it('reads a refund as income', () => {
    expect(parse(NU, 'Estorno', 'A compra em Corrida App no valor de R$ 12,34 foi estornada.')).toEqual({
      kind: 'REFUND', type: 'INCOME', amount: 12.34, description: 'Estorno: Corrida App',
    });
  });

  it('reads "sua transferência" as an own transfer: no type, so nothing becomes income by itself, and not ignored', () => {
    const parsed = parse(NU, 'Transferência recebida', 'Recebemos sua transferência de R$ 2.500,00.');
    expect(parsed).toEqual({ kind: 'OWN_TRANSFER_IN', type: null, amount: 2500, description: 'Transferência recebida' });
    expect(parsed).not.toHaveProperty('ignore');
  });

  it('ignores the known informative notice about the sending limit', () => {
    expect(parse(NU, 'Seu novo limite está valendo', 'Agora você pode enviar até R$ 80.000,00 via Pix, TED e boleto de dia.')).toEqual({
      kind: 'IGNORE', type: null, amount: null, description: null, ignore: true,
    });
  });

  it.each([
    ['advertising', 'Promoção de fim de ano', 'Ganhe até 50% OFF pagando com o cartão. Resgate seu cupom agora.'],
    ['purchase without an amount', 'Compra no crédito aprovada', 'Compra APROVADA em LOJA para o cartão com final 1234.'],
    ['purchase with a broken amount', 'Compra no crédito aprovada', 'Compra de R$ abc APROVADA em LOJA para o cartão com final 1234.'],
    ['refund without a merchant', 'Estorno', 'Sua compra foi estornada.'],
    ['transfer with a zero amount', 'Transferência recebida', 'Recebemos sua transferência de R$ 0,00.'],
    ['empty text', 'Estorno', ''],
  ])('does not understand %s', (_name, title, text) => {
    expect(parse(NU, title, text)).toBeNull();
  });

  it('reads by the text when the title is missing', () => {
    expect(parse(NU, null, 'Recebemos sua transferência de R$ 3,00.')).toMatchObject({ kind: 'OWN_TRANSFER_IN', type: null, amount: 3 });
  });
});

describe('Mercado Pago', () => {
  it('reads a Pix deposit into the own account as an own transfer, without a type', () => {
    expect(parse(MP, 'Seu dinheiro já está disponível', 'Você depositou R$ 1.050,25 via Pix e o valor já está rendendo na sua conta.')).toEqual({
      kind: 'OWN_TRANSFER_IN', type: null, amount: 1050.25, description: 'Depósito via Pix',
    });
  });

  it('does not understand an unknown notice', () => {
    expect(parse(MP, 'Novidade', 'Conheça o novo jeito de investir.')).toBeNull();
  });
});

describe('dispatch', () => {
  it('returns null for apps without a parser (XP and any other package)', () => {
    expect(parse('br.com.xp.carteira', 'Compra', 'Compra de R$ 10,00 APROVADA em LOJA para o cartão com final 1234.')).toBeNull();
    expect(parse('com.example.bank', 'Estorno', 'A compra em X no valor de R$ 1,00 foi estornada.')).toBeNull();
  });

  it('does not read a Nubank text sent by the Mercado Pago package', () => {
    expect(parse(MP, 'Estorno', 'A compra em X no valor de R$ 1,00 foi estornada.')).toBeNull();
  });

  it('exposes a positive integer parser version', () => {
    expect(Number.isInteger(PARSER_VERSION)).toBe(true);
    expect(PARSER_VERSION).toBeGreaterThan(0);
  });
});
