import { Module } from '@nestjs/common';
import { FirebaseAuthService } from '../firebase/firebase-auth.service';
import { openClassesCheckerProvider } from './open-classes.checker';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, FirebaseAuthService, openClassesCheckerProvider],
  exports: [UsersService, FirebaseAuthService],
})
export class UsersModule {}
