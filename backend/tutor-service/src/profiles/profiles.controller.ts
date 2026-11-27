import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import type { z } from 'zod';
import { ProfilesService, view } from './profiles.service';
import { CredentialInput, ListQuery, ProfileInput, ReviewInput } from './schemas';

/** A stored file as a download: never rendered by the browser as a page. */
function download(file: { name: string; mime: string; sha256: string }, data: Buffer) {
  return new StreamableFile(data, {
    type: file.mime,
    disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    length: data.length,
  });
}

/** The Tutor's own profile (docs/07 §2). An Admin who teaches has one too (BR-AU-01). */
@ApiTags('tutors')
@Roles('TUTOR', 'ADMIN')
@Controller('tutors/me')
export class MyProfileController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  async mine(@CurrentUser() actor: AuthUser) {
    return view(await this.profiles.mine(actor), false);
  }

  @Put()
  async save(@CurrentUser() actor: AuthUser, @Body(new ZodBody(ProfileInput)) body: ProfileInput) {
    return view(await this.profiles.save(actor, body), false);
  }

  @Post('credentials')
  async addCredential(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodBody(CredentialInput)) body: CredentialInput,
  ) {
    return view(await this.profiles.addCredential(actor, body), false);
  }

  @Delete('credentials/:id')
  async removeCredential(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return view(await this.profiles.removeCredential(actor, id), false);
  }

  @Get('credentials/:id/file')
  async file(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { file, data } = await this.profiles.credentialFile(actor, actor.id, id);
    return download(file, data);
  }

  @Post('submit')
  @HttpCode(200)
  async submit(@CurrentUser() actor: AuthUser) {
    return view(await this.profiles.submit(actor), false);
  }
}

/** Admins review Tutors. */
@ApiTags('tutors')
@Roles('ADMIN')
@Controller('tutors')
export class ReviewController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  list(@Query(new ZodBody(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.profiles.list(q);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return view(await this.profiles.get(id), true);
  }

  @Get(':id/credentials/:cid/file')
  async file(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
  ) {
    const { file, data } = await this.profiles.credentialFile(actor, id, cid);
    return download(file, data);
  }

  @Post(':id/review')
  @HttpCode(200)
  async review(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(ReviewInput)) body: ReviewInput,
  ) {
    return view(await this.profiles.review(actor, id, body), true);
  }
}
