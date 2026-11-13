import { describe, expect, it } from 'vitest';
import { parseCapture } from './index.js';

const GM = 'com.google.android.gm';
const pixText = (value: string, extra = '') =>
  `Seu Pix foi enviado\nConfira o comprovante e os dados de quem recebeu o Pix.\nSeu Pix de R$ ${value} foi enviado\nQuinta-feira, 12 de novembro de 2026, às 10:15:30.\nMARIA FICTICIA DA SILVA\nCPF/CNPJ: ***.123.456-**\nMercado Pago${extra}`;

describe('Mercado Pago Pix sent, notified by Gmail', () => {
  it('reads the amount and the receiver name as an expense, never the document', () => {
    const parsed = parseCapture({ package: GM, title: 'Mercado Pago', text: pixText('1.234,56') });
    expect(parsed).toEqual({ kind: 'PIX_OUT', type: 'EXPENSE', amountCents: 123456, amount: 1234.56, method: 'PIX', description: 'MARIA FICTICIA DA SILVA' });
    expect(JSON.stringify(parsed)).not.toContain('123.456');
  });

  it('reads an amount without cents', () => {
    expect(parseCapture({ package: GM, title: 'Mercado Pago', text: pixText('320') })).toMatchObject({ kind: 'PIX_OUT', amountCents: 32000, amount: 320 });
  });

  it('reads a text cut right after the date (no receiver name): generic description', () => {
    const cut = 'Seu Pix foi enviado\nConfira o comprovante e os dados de quem recebeu o Pix.\nSeu Pix de R$ 45,90 foi enviado\nQuinta-feira, 12 de novembro de 2026, às 10:15:30.';
    expect(parseCapture({ package: GM, title: 'Mercado Pago', text: cut })).toMatchObject({ amount: 45.9, description: 'Pix enviado' });
  });

  it('does not take the document line as the receiver name', () => {
    const noName = 'Seu Pix de R$ 5,00 foi enviado\nQuinta-feira, 12 de novembro de 2026, às 10:15:30.\nCPF/CNPJ: ***.123.456-**';
    expect(parseCapture({ package: GM, title: 'Mercado Pago', text: noName })).toMatchObject({ description: 'Pix enviado' });
  });

  it.each([
    ['another sender', 'Banco Qualquer', pixText('10,00')],
    ['no title', null, pixText('10,00')],
    ['another Gmail text of the same sender', 'Mercado Pago', 'Sua fatura está disponível. Valor: R$ 10,00.'],
    ['zero amount', 'Mercado Pago', pixText('0,00')],
    ['broken amount', 'Mercado Pago', pixText('1,2,3')],
  ])('returns null for %s', (_n, title, text) => {
    expect(parseCapture({ package: GM, title, text })).toBeNull();
  });

  it('does not read the same text from another package', () => {
    expect(parseCapture({ package: 'com.mercadopago.wallet', title: 'Mercado Pago', text: pixText('10,00') })).toBeNull();
  });
});

describe('Nubank NuPay refund', () => {
  const NU = 'com.nu.production';
  it('reads the cut start as a refund (income) with the merchant, amount unknown', () => {
    expect(parseCapture({ package: NU, title: 'Estorno', text: 'NuPay: estorno recebido de compra no crédito na Loja Ficticia…' })).toEqual({
      kind: 'REFUND', type: 'INCOME', amountCents: null, amount: null, merchant: 'Loja Ficticia', description: 'Estorno: Loja Ficticia',
    });
  });

  it('takes the amount when the text carries it', () => {
    expect(parseCapture({ package: NU, title: 'Estorno', text: 'NuPay: estorno recebido de compra no crédito na Loja Ficticia no valor de R$ 1.200,50.' })).toMatchObject({
      amountCents: 120050, amount: 1200.5, description: 'Estorno: Loja Ficticia',
    });
  });

  it('does not read a refund text without the NuPay start', () => {
    expect(parseCapture({ package: NU, title: 'Estorno', text: 'estorno recebido' })).toBeNull();
  });
});
