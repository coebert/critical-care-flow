import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function IdleTimeoutModal({
  open,
  secondsLeft,
  onStayActive,
  onSignOutNow,
}: {
  open: boolean;
  secondsLeft: number;
  onStayActive: () => void;
  onSignOutNow: () => void;
}) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>You&rsquo;ll be signed out shortly</AlertDialogTitle>
          <AlertDialogDescription>
            For patient safety, this session ends after a period of inactivity.
            You&rsquo;ll be signed out in <strong>{secondsLeft}</strong> second{secondsLeft === 1 ? "" : "s"}
            {" "}unless you continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onSignOutNow}>Sign out now</Button>
          <AlertDialogAction onClick={onStayActive}>Stay signed in</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
