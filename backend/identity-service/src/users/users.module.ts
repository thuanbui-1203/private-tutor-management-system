import { Module } from '@nestjs/common';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, FirebaseAuthService],
  exports: [UsersService, FirebaseAuthService],
})
export class UsersModule {}
