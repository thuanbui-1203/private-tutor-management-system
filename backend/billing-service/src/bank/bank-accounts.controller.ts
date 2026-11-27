import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import { BankAccountInput, BankAccountsService } from './bank-accounts.service';
import { VN_BANKS } from './vn-banks';

/** Bank details, stored only with consent (ADR-0006). */
@ApiTags('billing')
@Controller('billing')
export class BankAccountsController {
  constructor(private readonly accounts: BankAccountsService) {}

  /** Banks that take NAPAS 247 transfers, for the bank picker (scripts/update-reference-data.mjs). */
  @Get('banks')
  banks() {
    return VN_BANKS.filter((b) => b.transfer).map(({ bin, code, shortName, name }) => ({
      bin,
      code,
      shortName,
      name,
    }));
  }

  /** Your own account (number masked) and the policy version to consent to. */
  @Get('bank-account')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  mine(@CurrentUser() actor: AuthUser) {
    return this.accounts.mine(actor);
  }

  /** Save your account; the body must carry `consent: true` and the policy version. */
  @Put('bank-account')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  save(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodBody(BankAccountInput)) body: BankAccountInput,
  ) {
    return this.accounts.save(actor, body);
  }

  /** Withdraw consent: the full number and holder name are erased, a masked copy stays. */
  @Delete('bank-account/consent')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  withdraw(@CurrentUser() actor: AuthUser) {
    return this.accounts.withdraw(actor);
  }

  /** Payers' accounts for refunds (a Tutor: their own Students' Payers only). */
  @Get('bank-accounts')
  @Roles('TUTOR', 'ADMIN')
  payers(@CurrentUser() actor: AuthUser) {
    return this.accounts.payerAccounts(actor);
  }
}
