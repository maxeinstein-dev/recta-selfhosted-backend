import { describe, expect, it } from 'vitest';
import { PARSER_VERSION, parseCapture } from './index.js';
import { parseBrlAmount, parseBrlCents } from './amount.js';

// Fixtures keep the exact shape of the real notification texts; merchants, people, amounts and card endings are invented.
const NU = 'com.nu.production';
const MP = 'com.mercadopago.wallet';
const parse = (pkg: string, title: string | null, text: string) => parseCapture({ package: pkg, title, text });
const NBSP = ' ';

describe('parseBrlCents (Brazilian reais to integer cents)', () => {
  it.each([
    ['9,90', 990],
    ['0,01', 1],
    ['200,00', 20000],
    ['1.234,56', 123456],
    ['50.000,00', 5000000],
    ['1.234.567,89', 123456789],
    ['15', 1500],
    // 0,29 * 100 is 28.999... in floating point: the cents come from the digits, never from a product.
    ['0,29', 29],
    ['1.000.000,07', 100000007],
  ])('reads %s as %d cents', (raw, expected) => {
    expect(parseBrlCents(raw)).toBe(expected);
  });

  it.each(['', 'abc', '1,2,3', '1.23,4', '12,345', '-5,00', '1,234.56', '1.2345,00', '9'.repeat(14)])('refuses %j', (raw) => {
    expect(parseBrlCents(raw)).toBeNull();
  });

  it('parseBrlAmount is the same reading in reais', () => {
    expect(parseBrlAmount('1.234,56')).toBe(1234.56);
    expect(parseBrlAmount('x')).toBeNull();
  });
});

describe('Nubank', () => {
  it('reads a credit card purchase as an expense, keeping the merchant as it came', () => {
    expect(parse(NU, 'Compra no crédito aprovada', 'Compra de R$ 37,50 APROVADA em EC     *LOJAFICTICIA para o cartão com final 1234.')).toEqual({
      kind: 'CARD_PURCHASE', type: 'EXPENSE', amountCents: 3750, amount: 37.5, method: 'CREDIT',
      merchant: 'EC *LOJAFICTICIA', description: 'EC *LOJAFICTICIA', cardLast4: '1234',
    });
  });

  it('reads thousands and cents of a purchase', () => {
    const parsed = parse(NU, 'Compra no crédito aprovada', 'Compra de R$ 1.234,56 APROVADA em MERCADO TESTE para o cartão com final 9876.');
    expect(parsed).toMatchObject({ kind: 'CARD_PURCHASE', type: 'EXPENSE', amountCents: 123456, amount: 1234.56, merchant: 'MERCADO TESTE', cardLast4: '9876' });
  });

  it.each([
    ['lower case', 'compra de r$ 10,00 aprovada em PADARIA ALFA para o cartão com final 4321.'],
    ['no space after R$', 'Compra de R$10,00 APROVADA em PADARIA ALFA para o cartão com final 4321.'],
    ['non-breaking space after R$', `Compra de R$${NBSP}10,00 APROVADA em PADARIA ALFA para o cartão com final 4321.`],
    ['line breaks and extra spaces', 'Compra de  R$ 10,00\nAPROVADA em PADARIA ALFA\npara o cartão com final 4321'],
    ['spaces around the text', '   Compra de R$ 10,00 APROVADA em PADARIA ALFA para o cartão com final 4321.  '],
  ])('reads a purchase written with %s', (_name, text) => {
    expect(parse(NU, 'Compra no crédito aprovada', text)).toMatchObject({
      kind: 'CARD_PURCHASE', amountCents: 1000, merchant: 'PADARIA ALFA', cardLast4: '4321',
    });
  });

  it('reads a NuPay credit payment, with its number of installments (informative)', () => {
    expect(parse(NU, 'Pagamento com NuPay aprovado', 'R$ 12,34 em 1x no crédito sem juros com NuPay APROVADO em Corrida App.')).toEqual({
      kind: 'CARD_PURCHASE', type: 'EXPENSE', amountCents: 1234, amount: 12.34, method: 'NUPAY',
      merchant: 'Corrida App', description: 'Corrida App', installments: 1,
    });
    expect(parse(NU, 'Pagamento com NuPay aprovado', 'R$ 1.200,00 em 3x no crédito sem juros com NuPay APROVADO em Loja Online.')).toMatchObject({
      amountCents: 120000, installments: 3,
    });
  });

  it('reads a refund as income', () => {
    expect(parse(NU, 'Estorno', 'A compra em Corrida App no valor de R$ 12,34 foi estornada.')).toEqual({
      kind: 'REFUND', type: 'INCOME', amountCents: 1234, amount: 12.34, merchant: 'Corrida App', description: 'Estorno: Corrida App',
    });
  });

  it('reads "sua transferência" as income on the Nubank account, flagged as a possible own transfer', () => {
    expect(parse(NU, 'Transferência recebida', 'Recebemos sua transferência de R$ 2.500,00.')).toEqual({
      kind: 'PIX_IN', type: 'INCOME', amountCents: 250000, amount: 2500, method: 'TRANSFER',
      description: 'Transferência recebida', warning: 'POSSIBLE_OWN_TRANSFER',
    });
  });

  it('reads by the text when the title is missing', () => {
    expect(parse(NU, null, 'Recebemos sua transferência de R$ 3,00.')).toMatchObject({ kind: 'PIX_IN', type: 'INCOME', amountCents: 300 });
  });

  it.each([
    ['the sending limit', 'Seu novo limite está valendo', 'Agora você pode enviar até R$ 80.000,00 via Pix, TED e boleto de dia.'],
    ['a Pix offer with "até R$"', 'Pix no crédito', 'Faça Pix de até R$ 50.000,00 via Pix no crédito e pague depois.'],
    ['the FGTS anticipation', 'Antecipação do FGTS', 'Antecipe seu saque-aniversário do FGTS com taxa especial. Simule agora.'],
    ['advertising without an amount', 'Promoção de fim de ano', 'Ganhe até 50% OFF pagando com o cartão. Resgate seu cupom agora.'],
    ['a new credit limit offer', 'Limite disponível', 'Seu limite do cartão aumentou. Confira no app.'],
  ])('dismisses %s: a recognized notice is never a transaction', (_name, title, text) => {
    expect(parse(NU, title, text)).toEqual({ kind: 'IGNORE', type: null, amountCents: null, amount: null, description: null, ignore: true });
  });

  it.each([
    ['purchase without an amount', 'Compra no crédito aprovada', 'Compra APROVADA em LOJA para o cartão com final 1234.'],
    ['purchase with a broken amount', 'Compra no crédito aprovada', 'Compra de R$ abc APROVADA em LOJA para o cartão com final 1234.'],
    ['purchase with a five-digit card end', 'Compra no crédito aprovada', 'Compra de R$ 10,00 APROVADA em LOJA para o cartão com final 12345.'],
    ['refund without a merchant', 'Estorno', 'Sua compra foi estornada.'],
    ['transfer with a zero amount', 'Transferência recebida', 'Recebemos sua transferência de R$ 0,00.'],
    ['an unknown text with an amount', 'Novidade', 'Você ganhou R$ 20,00 de cashback para usar até domingo.'],
    ['an unknown transaction without an amount (cut text)', 'Pix enviado', 'Seu Pix foi enviado para…'],
    ['a debit purchase (format not seen yet)', 'Compra no débito', 'Compra de R$ 10,00 no débito aprovada em LOJA.'],
    ['empty text', 'Estorno', ''],
  ])('does not understand %s: null, never a guessed value', (_name, title, text) => {
    expect(parse(NU, title, text)).toBeNull();
  });
});

describe('Mercado Pago', () => {
  it('reads a Pix deposit as income, flagged as a possible own transfer (no pairing)', () => {
    expect(parse(MP, 'Seu dinheiro já está disponível', 'Você depositou R$ 1.050,25 via Pix e o valor já está rendendo na sua conta.')).toEqual({
      kind: 'PIX_IN', type: 'INCOME', amountCents: 105025, amount: 1050.25, method: 'PIX',
      description: 'Depósito via Pix', warning: 'POSSIBLE_OWN_TRANSFER',
    });
  });

  it('reads the deposit in other case and spacing', () => {
    expect(parse(MP, null, 'você depositou R$ 7,00 via pix e o valor já está rendendo\nna sua conta')).toMatchObject({ kind: 'PIX_IN', amountCents: 700 });
  });

  it.each([
    ['an investment ad', 'Novidade', 'Conheça o novo jeito de investir.'],
    ['a promotional "até R$"', 'Empréstimo', 'Você tem até R$ 10.000,00 disponíveis para empréstimo.'],
  ])('dismisses %s', (_name, title, text) => {
    expect(parse(MP, title, text)).toMatchObject({ kind: 'IGNORE', ignore: true, amountCents: null });
  });

  it('does not understand an unknown text that carries an amount', () => {
    expect(parse(MP, 'Pix recebido', 'Você recebeu R$ 30,00 de FULANO.')).toBeNull();
  });
});

describe('dispatch', () => {
  it('returns null for apps without a parser (XP and any other package)', () => {
    expect(parse('br.com.xp.carteira', 'Compra', 'Compra de R$ 10,00 APROVADA em LOJA para o cartão com final 1234.')).toBeNull();
    expect(parse('com.example.bank', 'Promoção', 'Ganhe um cupom.')).toBeNull();
  });

  it('does not read a Nubank text sent by the Mercado Pago package', () => {
    expect(parse(MP, 'Estorno', 'A compra em X no valor de R$ 1,00 foi estornada.')).toBeNull();
  });

  it('every understood reading carries integer cents equal to the amount in reais', () => {
    const texts: Array<[string, string]> = [
      [NU, 'Compra de R$ 0,29 APROVADA em LOJA para o cartão com final 1234.'],
      [NU, 'R$ 19,99 em 2x no crédito sem juros com NuPay APROVADO em Loja.'],
      [NU, 'Recebemos sua transferência de R$ 1.000,10.'],
      [MP, 'Você depositou R$ 0,07 via Pix e o valor já está rendendo na sua conta.'],
    ];
    for (const [pkg, text] of texts) {
      const parsed = parse(pkg, null, text)!;
      expect(Number.isInteger(parsed.amountCents)).toBe(true);
      expect(parsed.amount).toBe(parsed.amountCents! / 100);
    }
  });

  it('exposes a positive integer parser version, newer than the first reader (3)', () => {
    expect(Number.isInteger(PARSER_VERSION)).toBe(true);
    expect(PARSER_VERSION).toBeGreaterThan(3);
  });
});
