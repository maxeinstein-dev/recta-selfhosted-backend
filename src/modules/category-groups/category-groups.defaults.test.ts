import { describe, expect, it } from 'vitest';
import { CategoryType, getCategoriesByType } from '../../shared/enums/index.js';
import { DEFAULT_GROUPS, defaultAssignments, isReservedGroupName, OTHER_GROUP_NAME } from './category-groups.defaults.js';

// Invented data only.
describe('default spending groups', () => {
  it('are Casa (housing), Pessoal and Dia a dia, in this order', () => {
    expect(DEFAULT_GROUPS.map((g) => [g.name, g.isHousing])).toEqual([
      ['Casa', true],
      ['Pessoal', false],
      ['Dia a dia', false],
    ]);
  });

  it('place Moradia and Contas in Casa, health and car in Pessoal, food and leisure in Dia a dia', () => {
    const map = defaultAssignments([]);
    expect(map.get('HOUSING')).toBe('Casa');
    expect(map.get('UTILITIES')).toBe('Casa');
    expect(map.get('HEALTHCARE')).toBe('Pessoal');
    expect(map.get('FUEL')).toBe('Pessoal');
    expect(map.get('FOOD')).toBe('Dia a dia');
    expect(map.get('ENTERTAINMENT')).toBe('Dia a dia');
  });

  it('map every system expense category and never an income one', () => {
    const map = defaultAssignments([]);
    for (const name of getCategoriesByType(CategoryType.EXPENSE)) expect(map.has(name)).toBe(true);
    for (const name of getCategoriesByType(CategoryType.INCOME)) expect(map.has(name)).toBe(false);
    expect(map.has('TRANSFER')).toBe(false);
  });

  it('map custom expense categories by name (ignoring case and accents) and leave the unknown ones ungrouped', () => {
    const map = defaultAssignments([
      { id: 'a1', name: 'CASA', type: 'EXPENSE' },
      { id: 'a2', name: 'Saúde ', type: 'EXPENSE' },
      { id: 'a3', name: 'mimos', type: 'EXPENSE' },
      { id: 'a4', name: 'Alimentacao', type: 'EXPENSE' },
      { id: 'a5', name: 'Pet', type: 'EXPENSE' },
      { id: 'a6', name: 'Casa', type: 'INCOME' },
    ]);
    expect(map.get('CUSTOM:a1')).toBe('Casa');
    expect(map.get('CUSTOM:a2')).toBe('Pessoal');
    expect(map.get('CUSTOM:a3')).toBe('Pessoal');
    expect(map.get('CUSTOM:a4')).toBe('Dia a dia');
    expect(map.has('CUSTOM:a5')).toBe(false);
    expect(map.has('CUSTOM:a6')).toBe(false);
  });

  it('reserve the name of the virtual group for the ungrouped categories', () => {
    expect(OTHER_GROUP_NAME).toBe('Outros');
    expect(isReservedGroupName(' outros ')).toBe(true);
    expect(isReservedGroupName('Outras coisas')).toBe(false);
  });
});
