import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { isPlayerRoute } from './utils/player-link';
import { MainComponent } from './main/main.component';
import { PlayerComponent } from './player/player.component';
import { SubscriptionsComponent } from './subscriptions/subscriptions.component';
import { SubscriptionComponent } from './subscription/subscription/subscription.component';
import { PostsService } from './posts.services';
import { LoginComponent } from './components/login/login.component';
import { DownloadsComponent } from './components/downloads/downloads.component';
import { DuplicatesComponent } from './components/duplicates/duplicates.component';
import { SettingsComponent } from './settings/settings.component';
import { TasksComponent } from './components/tasks/tasks.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: PlayerComponent, data: {player: true},
    canMatch: [() => isPlayerRoute(inject(Router).currentNavigation()?.extractedUrl.toString() ?? '/')],
    canActivate: [PostsService] },
  { path: '', pathMatch: 'full', component: MainComponent, canActivate: [PostsService] },
  { path: 'subscriptions', component: SubscriptionsComponent, canActivate: [PostsService] },
  { path: 'subscription', component: SubscriptionComponent, canActivate: [PostsService] },
  { path: 'settings', component: SettingsComponent, canActivate: [PostsService] },
  { path: 'login', component: LoginComponent },
  { path: 'downloads', component: DownloadsComponent, canActivate: [PostsService] },
  { path: 'duplicates', component: DuplicatesComponent, canActivate: [PostsService] },
  { path: 'tasks', component: TasksComponent, canActivate: [PostsService] }
];
