// Handle form submission
document.getElementById('designRequestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);
    
    // Handle checkbox value
    data.agreeTerms = document.getElementById('agreeTerms').checked;
    
    // Trim whitespace from text fields
    if (data.clientName) data.clientName = data.clientName.trim();
    if (data.email) data.email = data.email.trim();
    if (data.projectType) data.projectType = data.projectType.trim();
    if (data.timeline) data.timeline = data.timeline.trim();
    if (data.budget) data.budget = data.budget.trim();
    if (data.designDescription) data.designDescription = data.designDescription.trim();
    if (data.referenceWebsites) data.referenceWebsites = data.referenceWebsites.trim();
    if (data.colorPreferences) data.colorPreferences = data.colorPreferences.trim();
    if (data.stylePreferences) data.stylePreferences = data.stylePreferences.trim();
    if (data.keyFeatures) data.keyFeatures = data.keyFeatures.trim();
    
    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting...';
    
    const messageDiv = document.getElementById('formMessage');
    messageDiv.className = 'form-message';
    messageDiv.textContent = '';
    
    try {
        const response = await fetch('/api/submit-request', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        
        // Check if response is actually JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('Non-JSON response received:', text.substring(0, 200));
            throw new Error('Server returned an invalid response. Please check if the server is running.');
        }
        
        const result = await response.json();
        
        if (response.ok) {
            messageDiv.className = 'form-message success';
            messageDiv.textContent = 'Request submitted successfully! We will review your website specifics and get back to you soon.';
            
            // Reset form
            e.target.reset();
            
            // Scroll to message
            messageDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            throw new Error(result.error || 'Failed to submit request');
        }
    } catch (error) {
        messageDiv.className = 'form-message error';
        messageDiv.textContent = error.message || 'An error occurred. Please try again.';
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
    }
});

// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
        }
    });
});
