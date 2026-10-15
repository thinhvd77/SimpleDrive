import { z } from 'zod';

export const employeeCodeSchema = z.string()
  .trim().min(1, 'Vui lòng nhập mã nhân viên.').max(50, 'Mã nhân viên tối đa 50 ký tự.')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Mã nhân viên chỉ gồm chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.')
  .transform(value => value.toUpperCase());
