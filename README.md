# Critical Care Connect

I want to build an app for critical care clinicians at Salisbury District Hospital. As part of the data required for ICNARC, the critical care unit is required to submit accurate data on patient referrals to critical care, including time and date of referral, time referral first seen by a member of the critical care team, if referral declined then reason for declining, if admitted then time of decision to admit and time patient actually arrived on the critical care unit. It would also be helpful for there to be the ability to document some key details about the referral, such as age and sex of patient, hospital number, current location (ward and bed number), past medical history, baseline level of function, referring specialty, whether a DNACPR/RESPECT form is already in place, reason for referral to critical care. The app will need to be accessed by various members of the critical care team, with details of referrals/a list of referrals viewable by all team members. However, because of the importance of proper information governance, it is very important that the app holds all data securely. Only team members with log-ins should be able to access information. Ideally, all data held by the app should be encrypted. Please also add the ability for the app to send push notifications to tell clinicians when a new referral has been added to the system or when a referral has been updated. It would also be helpful for clinicians to be able to add brief notes to each referral, such as 'seen in ED resus, awaiting bloods, for re-review at 6pm'. I want the app to be able to audit/analyze data collected and display this on a separate tab/page (for example, number of referrals over time, mean number of referrals per 24 hours, referrals by specialty, mean age of referrals.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://critical-care-flow.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/a8eeeba1-1944-4344-93c0-4f9de4184412).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
